import {
  app,
  BrowserWindow,
  ipcMain,
  clipboard,
  safeStorage,
  Menu,
  nativeTheme,
  shell,
  session,
} from 'electron';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { models } from '../core/catalog.js';
import { refreshAA, readBoundedResponseText } from '../core/aa/refresh.js';
import { targetHome, createService } from './service.js';
import { trustedRendererURL, rendererCSP } from './security.js';
import { windowOptions, linuxDataDir } from './window.js';
import {
  updateRequestPolicy,
  isSignedMacApp,
  createUpdater,
  readUpdateConsent,
  writeUpdateConsent,
  RELEASES_URL,
  allowedUpdateURL,
  type UpdaterPort,
} from './updater.js';
const mark = process.env.ENSEMBLE_PERF
  ? (label: string) =>
      console.log(
        `[perf] ${label} +${Math.round(Date.now() - (process.getCreationTime() ?? Date.now()))}ms`,
      )
  : () => undefined;
mark('main-loaded');
const home = targetHome(app.isPackaged, homedir(), process.cwd(), process.env.ENSEMBLE_HOME);
const sandbox = !app.isPackaged || !!process.env.ENSEMBLE_HOME;
const data = sandbox
  ? path.join(home, '.ensemble', 'app-data')
  : process.platform === 'linux'
    ? linuxDataDir(home, process.env.XDG_CONFIG_HOME)
    : app.getPath('userData');
app.setPath('userData', data);
app.setPath('sessionData', data);
app.setPath('crashDumps', path.join(data, 'crashes'));
app.setAppLogsPath(path.join(data, 'logs'));
const service = createService(home);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererFile = path.resolve(dirname, '../renderer/index.html');
const devURL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const keyFile = path.join(data, 'api-key.bin');
let win: BrowserWindow | undefined;
let encryptedKey: Buffer | undefined;
let refreshing = false;
function secureStorageReady() {
  return (
    safeStorage.isEncryptionAvailable() &&
    !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
  );
}
function openWindow() {
  win = new BrowserWindow({
    ...windowOptions(
      process.platform,
      path.resolve(dirname, '../preload/index.cjs'),
      nativeTheme.shouldUseDarkColors,
    ),
    ...(process.platform !== 'darwin'
      ? {
          icon: app.isPackaged
            ? path.join(process.resourcesPath, 'icon.png')
            : path.join(app.getAppPath(), 'build/icon.png'),
        }
      : {}),
  });
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const headers = Object.fromEntries(
      Object.entries(details.responseHeaders ?? {}).filter(
        ([key]) => key.toLowerCase() !== 'content-security-policy',
      ),
    );
    callback({
      responseHeaders: { ...headers, 'Content-Security-Policy': [rendererCSP(!!devURL)] },
    });
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  win.once('show', () => mark('window-shown'));
  win.webContents.on('did-finish-load', () => mark('renderer-loaded'));
  win.once('ready-to-show', () => {
    mark('first-paint');
    win?.show();
  });
  if (devURL) void win.loadURL(devURL);
  else void win.loadFile(rendererFile);
}
let dirsReady: Promise<unknown> = Promise.resolve();
function handle(channel: string, action: (raw: unknown) => unknown) {
  ipcMain.handle('ensemble:' + channel, (event, raw: unknown) => {
    const frame = event.senderFrame;
    const trusted = frame && trustedRendererURL(frame.url, rendererFile, devURL);
    if (!win || event.sender !== win.webContents || frame !== win.webContents.mainFrame || !trusted)
      throw new Error('Unauthorized IPC');
    return dirsReady.then(() => action(raw));
  });
}
// Slow work (keychain, codesign probe, updater import) runs off the window's critical path.
async function bootstrap() {
  await dirsReady;
  if (secureStorageReady()) {
    try {
      const stored = await readFile(keyFile);
      if (stored.byteLength > 0 && stored.byteLength <= 4096) encryptedKey = stored;
    } catch {
      /* No stored key yet. */
    }
  }
  // Load Electron integration only at runtime; the state machine has no Electron dependency.
  // electron-updater 6.8 uses this dedicated partition (ElectronHttpExecutor).
  // Strip its persistent staging identifier and block unrelated network destinations.
  session
    .fromPartition('electron-updater', { cache: false })
    .webRequest.onBeforeSendHeaders((details, callback) => {
      callback(updateRequestPolicy(details.url, details.requestHeaders));
    });
  const { default: electronUpdater } = await import('electron-updater');
  const { autoUpdater } = electronUpdater;
  const updaterPort: UpdaterPort = autoUpdater;
  autoUpdater.setFeedURL({ provider: 'github', owner: 'kuarezma', repo: 'ensemble-ai' });
  const updates = createUpdater({
    updater: updaterPort,
    packaged: app.isPackaged && !sandbox,
    platform: process.platform,
    appImage: !!process.env.APPIMAGE,
    macSigned:
      process.platform === 'darwin' && app.isPackaged && !sandbox
        ? await isSignedMacApp(app.getAppPath())
        : false,
    currentVersion: app.getVersion(),
    enabled: await readUpdateConsent(data),
    persist: (enabled) => writeUpdateConsent(data, enabled),
  });
  app.on('before-quit', () => updates.stop());
  return { updates };
}
app.whenReady().then(() => {
  dirsReady = Promise.all([mkdir(home, { recursive: true }), mkdir(data, { recursive: true })]);
  nativeTheme.themeSource = 'system';
  mark('app-ready');
  openWindow();
  mark('window-created');
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
  const boot = bootstrap();
  boot.catch(() => undefined);
  const UpdateActionSchema = z.discriminatedUnion('type', [
    z.object({ type: z.enum(['status', 'check', 'restart', 'download', 'notes']) }).strict(),
    z.object({ type: z.literal('configure'), enabled: z.boolean() }).strict(),
  ]);
  handle('update', async (raw) => {
    const { updates } = await boot;
    const action = UpdateActionSchema.parse(raw);
    if (action.type === 'configure') await updates.setEnabled(action.enabled);
    if (action.type === 'check') void updates.check();
    if (action.type === 'restart') updates.restart();
    if (action.type === 'notes' || action.type === 'download') {
      if (allowedUpdateURL(RELEASES_URL)) await shell.openExternal(RELEASES_URL);
    }
    return updates.snapshot();
  });
  handle('catalog', async () => ({
    ...service.catalog(),
    platform: process.platform,
    sandbox,
    recoveries: (await service.recoveries()).map(({ id, status }) => ({ id, status })),
  }));
  handle('plan', (raw) => service.plan(raw));
  handle('preview', (raw) => service.preview(raw));
  handle('apply', (raw) => service.apply(raw));
  handle('revert', (raw) => service.revert(raw));
  handle('copy', (raw) => clipboard.writeText(z.string().max(2_000_000).parse(raw)));
  handle('key', async (raw) => {
    await boot;
    const key = z.string().max(1024).parse(raw);
    if (!key) {
      encryptedKey = undefined;
      await rm(keyFile, { force: true });
      return;
    }
    if (!secureStorageReady()) throw new Error('Secure storage unavailable');
    encryptedKey = safeStorage.encryptString(key);
    await writeFile(keyFile + '.tmp', encryptedKey, { mode: 0o600 });
    await rename(keyFile + '.tmp', keyFile);
  });
  handle('refresh', async (raw) => {
    const consent = z.boolean().parse(raw);
    if (!consent) return { models, changes: 0 };
    await boot;
    if (refreshing) throw new Error('Refresh in progress');
    refreshing = true;
    try {
      const result = await refreshAA({
        consent,
        cacheDir: data,
        known: models,
        ...(encryptedKey
          ? {
              fetcher: async () => {
                const response = await fetch(
                  'https://artificialanalysis.ai/api/v2/data/llms/models',
                  {
                    headers: {
                      'x-api-key': safeStorage.decryptString(encryptedKey!),
                      'User-Agent': 'Ensemble/0.1',
                    },
                    signal: AbortSignal.timeout(20_000),
                    redirect: 'error',
                  },
                );
                if (!response.ok) throw new Error('Model service request failed');
                const payload = z
                  .object({
                    data: z.array(
                      z
                        .object({
                          slug: z.string(),
                          name: z.string(),
                          evaluations: z
                            .object({
                              artificial_analysis_intelligence_index: z
                                .number()
                                .nullable()
                                .optional(),
                            })
                            .passthrough()
                            .nullable()
                            .optional(),
                          pricing: z
                            .object({
                              price_1m_input_tokens: z.number().nullable().optional(),
                              price_1m_output_tokens: z.number().nullable().optional(),
                            })
                            .passthrough()
                            .nullable()
                            .optional(),
                          median_output_tokens_per_second: z.number().nullable().optional(),
                        })
                        .passthrough(),
                    ),
                  })
                  .parse(JSON.parse(await readBoundedResponseText(response)));
                // Retain variants whose effort is documented in the catalog or explicitly declared in the slug/name.
                const records = payload.data.flatMap((row) => {
                  const intelligenceIndex =
                    row.evaluations?.artificial_analysis_intelligence_index ?? null;
                  if (typeof intelligenceIndex !== 'number') return [];
                  const knownEfforts = models.flatMap((model) =>
                    model.efforts
                      .filter((e) => e.source.endsWith('/' + row.slug))
                      .map((e) => e.effort),
                  );
                  const suffix = [
                    'non-reasoning',
                    'none',
                    'low',
                    'medium',
                    'high',
                    'xhigh',
                    'max',
                  ].find((e) => row.slug.endsWith('-' + e));
                  const efforts = knownEfforts.length
                    ? knownEfforts
                    : suffix
                      ? [suffix === 'non-reasoning' ? 'none' : suffix]
                      : [];
                  return efforts.map((effort) => ({
                    slug: row.slug,
                    name: row.name,
                    shortName: row.name,
                    effort: { slug: effort },
                    intelligenceIndex,
                    price1mInputTokens: row.pricing?.price_1m_input_tokens ?? null,
                    price1mOutputTokens: row.pricing?.price_1m_output_tokens ?? null,
                    medianOutputTokensPerSecond: row.median_output_tokens_per_second ?? null,
                  }));
                });
                return new Response(records.map((r) => JSON.stringify(r)).join('\n'));
              },
            }
          : {}),
      });
      return { models: result.models, changes: result.changes.length };
    } finally {
      refreshing = false;
    }
  });
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) openWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
