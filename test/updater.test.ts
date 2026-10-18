import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  updateRequestPolicy,
  createUpdater,
  allowedUpdateURL,
  RELEASES_URL,
  readUpdateConsent,
  writeUpdateConsent,
} from '../src/main/updater.js';
function fixture(overrides: Partial<Parameters<typeof createUpdater>[0]> = {}) {
  const port = Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(async () => {}),
    downloadUpdate: vi.fn(async () => {}),
    quitAndInstall: vi.fn(),
  });
  const persist = vi.fn(async () => {});
  const updates = createUpdater({
    updater: port,
    packaged: true,
    platform: 'win32',
    appImage: false,
    currentVersion: '0.1.1',
    enabled: true,
    persist,
    ...overrides,
  });
  return { port, updates, persist };
}
afterEach(() => vi.useRealTimers());
it('disabled consent schedules no requests; manual check remains possible', async () => {
  vi.useFakeTimers();
  const { updates, port } = fixture({ enabled: false });
  await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);
  expect(port.checkForUpdates).not.toHaveBeenCalled();
  await updates.check();
  expect(port.checkForUpdates).toHaveBeenCalledOnce();
  updates.stop();
});
it('development is a no-op even for manual checks and restart', async () => {
  vi.useFakeTimers();
  const { updates, port } = fixture({ packaged: false });
  await updates.check();
  await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);
  updates.restart();
  expect(port.checkForUpdates).not.toHaveBeenCalled();
  expect(port.quitAndInstall).not.toHaveBeenCalled();
  expect(updates.snapshot().status).toBe('dev');
  updates.stop();
});
it('available → progress → downloaded installs only after explicit restart', async () => {
  const { updates, port } = fixture();
  expect(port.autoDownload).toBe(false);
  expect(port.autoInstallOnAppQuit).toBe(false);
  updates.restart();
  port.emit('update-available', { version: '0.1.2' });
  expect(port.downloadUpdate).toHaveBeenCalledOnce();
  port.emit('download-progress', { percent: 42.6 });
  expect(updates.snapshot()).toMatchObject({ status: 'downloading', percent: 43 });
  port.emit('update-downloaded', { version: '0.1.2' });
  expect(updates.snapshot().status).toBe('ready');
  expect(port.quitAndInstall).not.toHaveBeenCalled();
  updates.restart();
  expect(port.quitAndInstall).toHaveBeenCalledWith(false, true);
  updates.stop();
  expect(port.listenerCount('update-downloaded')).toBe(0);
});
it('errors fall back to download when a release is known and error otherwise', async () => {
  const { updates, port } = fixture();
  port.checkForUpdates.mockRejectedValueOnce(new Error('offline'));
  await updates.check();
  expect(updates.snapshot().status).toBe('error');
  port.emit('update-available', { version: '0.1.2' });
  port.emit('error', new Error('signature / download failed'));
  expect(updates.snapshot()).toMatchObject({ status: 'available', version: '0.1.2' });
  updates.restart();
  expect(port.quitAndInstall).not.toHaveBeenCalled();
  updates.stop();
});
it.each([{ platform: 'darwin' }, { platform: 'linux', appImage: false }])(
  'uses download fallback on $platform without install support',
  (options) => {
    const { updates, port } = fixture(options);
    port.emit('update-available', { version: '0.1.2' });
    expect(updates.snapshot().status).toBe('available');
    expect(port.downloadUpdate).not.toHaveBeenCalled();
    updates.restart();
    expect(port.quitAndInstall).not.toHaveBeenCalled();
    updates.stop();
  },
);
it('AppImage downloads in background', () => {
  const { updates, port } = fixture({ platform: 'linux', appImage: true });
  port.emit('update-available', { version: '0.1.2' });
  expect(port.downloadUpdate).toHaveBeenCalledOnce();
  updates.stop();
});
it('schedules startup at 10s and repeats every 6h; toggling and disposal cancel timers', async () => {
  vi.useFakeTimers();
  const { updates, port, persist } = fixture();
  port.checkForUpdates.mockImplementation(async () => {
    port.emit('update-not-available');
  });
  await vi.advanceTimersByTimeAsync(9999);
  expect(port.checkForUpdates).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(port.checkForUpdates).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 - 10000);
  expect(port.checkForUpdates).toHaveBeenCalledTimes(2);
  await updates.setEnabled(false);
  expect(persist).toHaveBeenCalledWith(false);
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
  expect(port.checkForUpdates).toHaveBeenCalledTimes(2);
  await updates.setEnabled(true);
  await vi.advanceTimersByTimeAsync(10000);
  expect(port.checkForUpdates).toHaveBeenCalledTimes(3);
  updates.stop();
  expect(vi.getTimerCount()).toBe(0);
});
it('prevents overlapping checks and preserves consent if persistence fails', async () => {
  const { updates, port } = fixture({
    persist: async () => {
      throw new Error('disk full');
    },
  });
  let resolve!: () => void;
  port.checkForUpdates.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const pending = updates.check();
  await updates.check();
  expect(port.checkForUpdates).toHaveBeenCalledOnce();
  resolve();
  await pending;
  await expect(updates.setEnabled(false)).rejects.toThrow('disk full');
  expect(updates.snapshot().enabled).toBe(true);
  updates.stop();
});
it('persists opt-out and fails closed on corrupt settings; restricts external links', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ensemble-updates-'));
  try {
    expect(await readUpdateConsent(dir)).toBe(true);
    await writeUpdateConsent(dir, false);
    expect(await readUpdateConsent(dir)).toBe(false);
    expect(JSON.parse(await readFile(path.join(dir, 'updates.json'), 'utf8'))).toEqual({
      automaticUpdates: false,
    });
    await writeFile(path.join(dir, 'updates.json'), '{broken');
    expect(await readUpdateConsent(dir)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect(allowedUpdateURL(RELEASES_URL)).toBe(true);
  for (const url of [
    'https://github.com.evil.test/',
    RELEASES_URL + '?next=evil',
    'file:///etc/passwd',
    'javascript:alert(1)',
  ])
    expect(allowedUpdateURL(url)).toBe(false);
});

it('transport strips persistent identifiers and credentials, permitting only GitHub release traffic', () => {
  const headers = {
    'X-User-Staging-Id': 'unique-install-id',
    Cookie: 'identity',
    Authorization: 'secret',
    Referer: 'private',
    Accept: 'application/json',
  };
  for (const url of [
    RELEASES_URL,
    'https://github.com/kuarezma/ensemble-ai/releases.atom',
    'https://github.com/kuarezma/ensemble-ai/releases/download/v0.1.2/latest.yml',
    'https://release-assets.githubusercontent.com/github-production-release-asset/123/abc?token=temporary',
  ]) {
    expect(updateRequestPolicy(url, headers)).toEqual({
      cancel: false,
      requestHeaders: { Accept: 'application/json' },
    });
  }
  for (const url of [
    'https://evil.test/payload',
    'http://github.com/kuarezma/ensemble-ai/releases/latest',
    'https://github.com/other/repo/releases/latest',
    'https://api.github.com/repos/kuarezma/ensemble-ai',
    'https://release-assets.githubusercontent.com/tracking',
    'file:///tmp/asset',
  ])
    expect(updateRequestPolicy(url, headers).cancel).toBe(true);
});
