import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { UpdateState } from '../shared/api.js';
export async function isSignedMacApp(appPath: string): Promise<boolean> {
  const bundle = path.resolve(appPath, '../../..');
  try {
    const run = promisify(execFile);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 10_000 });
    const result = await run('/usr/bin/codesign', ['--display', '--verbose=2', bundle], {
      timeout: 10_000,
    });
    return /Authority=Developer ID Application:/.test(result.stderr);
  } catch {
    return false;
  }
}

export const RELEASES_URL = 'https://github.com/kuarezma/ensemble-ai/releases/latest';
/** Renderer input and release metadata never become arbitrary shell URLs. */
export function allowedUpdateURL(value: string): boolean {
  return value === RELEASES_URL;
}
/** Runs for every request, including redirected release-asset downloads. */
export function updateRequestPolicy(value: string, headers: Record<string, string>) {
  let allowed = false;
  try {
    const url = new URL(value);
    const releasePath = '/kuarezma/ensemble-ai/releases';
    allowed =
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      ((url.hostname === 'github.com' &&
        (url.pathname === releasePath + '.atom' ||
          url.pathname === releasePath + '/latest' ||
          url.pathname.startsWith(releasePath + '/download/'))) ||
        ([
          'release-assets.githubusercontent.com',
          'objects.githubusercontent.com',
          'github-releases.githubusercontent.com',
        ].includes(url.hostname) &&
          url.pathname.startsWith('/github-production-release-asset')));
  } catch {
    /* Invalid URLs are denied. */
  }
  return {
    cancel: !allowed,
    requestHeaders: Object.fromEntries(
      Object.entries(headers).filter(
        ([name]) =>
          !['x-user-staging-id', 'cookie', 'authorization', 'referer'].includes(name.toLowerCase()),
      ),
    ),
  };
}
export async function readUpdateConsent(dataDir: string): Promise<boolean> {
  try {
    const config = JSON.parse(await readFile(path.join(dataDir, 'updates.json'), 'utf8'));
    return typeof config?.automaticUpdates === 'boolean' ? config.automaticUpdates : false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    // Corrupt or unreadable consent must not silently enable networking.
    return false;
  }
}
export async function writeUpdateConsent(dataDir: string, enabled: boolean) {
  const target = path.join(dataDir, 'updates.json');
  await writeFile(target + '.tmp', JSON.stringify({ automaticUpdates: enabled }) + '\n', {
    mode: 0o600,
  });
  await rename(target + '.tmp', target);
}
export interface UpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}
export function createUpdater(options: {
  updater: UpdaterPort;
  packaged: boolean;
  platform: string;
  appImage: boolean;
  macSigned?: boolean;
  currentVersion: string;
  enabled: boolean;
  persist: (enabled: boolean) => Promise<void>;
}) {
  const { updater } = options;
  // Current macOS releases are unsigned. Squirrel.Mac cannot install them.
  const canInstall =
    options.platform === 'win32' ||
    (options.platform === 'linux' && options.appImage) ||
    (options.platform === 'darwin' && options.macSigned === true);
  let state: UpdateState = {
    currentVersion: options.currentVersion,
    enabled: options.enabled,
    status: options.packaged ? 'idle' : 'dev',
  };
  let stopped = false;
  let checking = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let writes = Promise.resolve();
  const listeners: [string, (...args: unknown[]) => void][] = [];
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  function listen<T>(event: string, listener: (info: T) => void) {
    const callback = listener as (...args: unknown[]) => void;
    updater.on(event, callback);
    listeners.push([event, callback]);
  }
  function fail() {
    if (!stopped) state = { ...state, status: state.version ? 'available' : 'error' };
  }
  if (options.packaged) {
    listen<{ version: string }>('update-available', (info) => {
      if (stopped) return;
      state = { ...state, version: info.version, percent: undefined, status: 'available' };
      if (canInstall) {
        state.status = 'downloading';
        void updater.downloadUpdate().catch(fail);
      }
    });
    listen('update-not-available', () => {
      if (!stopped)
        state = { ...state, status: 'up-to-date', version: undefined, percent: undefined };
    });
    listen<{ percent: number }>('download-progress', (info) => {
      if (!stopped && state.status === 'downloading')
        state = { ...state, percent: Math.max(0, Math.min(100, Math.round(info.percent))) };
    });
    listen<{ version: string }>('update-downloaded', (info) => {
      if (!stopped && canInstall)
        state = { ...state, version: info.version, status: 'ready', percent: 100 };
    });
    listen('error', fail);
  }
  async function check() {
    if (
      stopped ||
      !options.packaged ||
      checking ||
      state.status === 'downloading' ||
      state.status === 'ready'
    )
      return;
    checking = true;
    state = { ...state, status: 'checking' };
    try {
      await updater.checkForUpdates();
    } catch {
      fail();
    } finally {
      checking = false;
    }
  }
  function clearTimers() {
    clearTimeout(timeout);
    clearInterval(interval);
  }
  function schedule() {
    clearTimers();
    if (!options.packaged || !state.enabled || stopped) return;
    timeout = setTimeout(() => void check(), 10_000);
    interval = setInterval(() => void check(), 6 * 60 * 60 * 1000);
    timeout.unref?.();
    interval.unref?.();
  }
  schedule();
  return {
    snapshot: (): UpdateState => ({ ...state }),
    check,
    setEnabled(enabled: boolean) {
      const write = writes.then(async () => {
        await options.persist(enabled);
        state = { ...state, enabled };
        schedule();
      });
      writes = write.catch(() => {});
      return write;
    },
    restart() {
      if (!stopped && options.packaged && canInstall && state.status === 'ready') {
        try {
          updater.quitAndInstall(false, true);
        } catch {
          fail();
        }
      }
    },
    stop() {
      stopped = true;
      clearTimers();
      for (const [event, listener] of listeners) updater.removeListener(event, listener);
    },
  };
}
