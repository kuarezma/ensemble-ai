import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rendererCSP } from '../src/main/security.js';
import { MAX_RESPONSE_BYTES } from '../src/core/aa/refresh.js';
const electron = vi.hoisted(() => ({
  updateHeaders: vi.fn(),
  handlers: new Map<string, (event: unknown, raw: unknown) => unknown>(),
  headers: undefined as
    | undefined
    | ((
        details: { responseHeaders: Record<string, string[]> },
        callback: (result: { responseHeaders: Record<string, string[]> }) => void,
      ) => void),
  contents: {
    mainFrame: { url: '' },
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    session: { setPermissionRequestHandler: vi.fn(), webRequest: { onHeadersReceived: vi.fn() } },
  },
}));
vi.mock('electron-updater', () => ({
  default: { autoUpdater: { setFeedURL: vi.fn(), on: vi.fn(), removeListener: vi.fn() } },
}));
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.1.1',
    getAppPath: () => '/unused/app.asar',
    setPath: vi.fn(),
    setAppLogsPath: vi.fn(),
    getPath: () => '/unused',
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: class {
    webContents = electron.contents;
    once() {}
    show() {}
    loadFile() {}
    loadURL() {}
    static getAllWindows() {
      return [];
    }
  },
  ipcMain: {
    handle: (name: string, handler: (event: unknown, raw: unknown) => unknown) =>
      electron.handlers.set(name, handler),
  },
  clipboard: { writeText: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'secure',
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
  shell: { openExternal: vi.fn() },
  session: {
    fromPartition: vi.fn(() => ({ webRequest: { onBeforeSendHeaders: electron.updateHeaders } })),
  },
  nativeTheme: { themeSource: 'system' },
}));
vi.mock('../src/core/catalog.js', async () => {
  const fixture = await import('./phase-d-fixtures.js');
  return {
    models: fixture.recoveryModels,
    tools: fixture.recoveryTools,
    subscriptions: fixture.recoverySubscriptions,
  };
});
vi.mock('../src/core/engine/index.js', async () => ({
  generatePlan: (await import('./phase-d-fixtures.js')).recoveryPlan,
}));
let home = '';
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});
it('permits local websocket connections only under the development response policy', () => {
  expect(rendererCSP(false)).not.toContain('ws:');
  expect(rendererCSP(true)).toContain('ws://localhost:*');
  expect(rendererCSP(true)).toContain('ws://127.0.0.1:*');
  expect(rendererCSP(false)).toContain("connect-src 'self';");
  expect(rendererCSP(true)).toContain("'nonce-ensemble-development-style'");
  expect(rendererCSP(false)).not.toContain('nonce-');
});
it('enforces production CSP, exposes recovery IPC and bounds authenticated main fetch bodies', async () => {
  await mkdir('.dev-data', { recursive: true });
  home = await mkdtemp(path.resolve('.dev-data/main-phase-d-'));
  vi.stubEnv('ENSEMBLE_HOME', home);
  electron.contents.mainFrame.url = pathToFileURL(path.resolve('src/renderer/index.html')).href;
  electron.contents.session.webRequest.onHeadersReceived.mockImplementation((handler) => {
    electron.headers = handler;
  });
  await import('../src/main/index.js');
  await vi.waitFor(() => expect(electron.headers).toBeDefined());
  const event = { sender: electron.contents, senderFrame: electron.contents.mainFrame };
  const invoke = (name: string, value?: unknown) =>
    electron.handlers.get('ensemble:' + name)!(event, value);
  expect(await invoke('catalog')).toHaveProperty('recoveries', []);
  const transportCallback = vi.fn();
  electron.updateHeaders.mock.calls[0]![0](
    {
      url: 'https://github.com/kuarezma/ensemble-ai/releases/latest',
      requestHeaders: { 'x-user-staging-id': 'unique-id', Accept: 'application/json' },
    },
    transportCallback,
  );
  expect(transportCallback).toHaveBeenCalledWith({
    cancel: false,
    requestHeaders: { Accept: 'application/json' },
  });

  expect(await invoke('update', { type: 'status' })).toMatchObject({
    currentVersion: '0.1.1',
    enabled: true,
    status: 'dev',
  });
  await expect(invoke('update', { type: 'configure', enabled: 'yes' })).rejects.toThrow();
  await expect(invoke('update', { type: 'download', url: 'https://evil.test' })).rejects.toThrow();
  await expect(invoke('update', { type: 'unknown' })).rejects.toThrow();
  expect(() =>
    electron.handlers.get('ensemble:update')!(
      { sender: {}, senderFrame: electron.contents.mainFrame },
      { type: 'restart' },
    ),
  ).toThrow('Unauthorized IPC');
  expect(await invoke('update', { type: 'configure', enabled: false })).toHaveProperty(
    'enabled',
    false,
  );
  await invoke('update', { type: 'notes' });
  const { shell } = await import('electron');
  expect(shell.openExternal).toHaveBeenCalledWith(
    'https://github.com/kuarezma/ensemble-ai/releases/latest',
  );

  const callback = vi.fn();
  electron.headers!(
    { responseHeaders: { 'content-security-policy': ['connect-src *'] } },
    callback,
  );
  expect(callback.mock.calls[0]![0].responseHeaders['Content-Security-Policy']).toEqual([
    rendererCSP(false),
  ]);
  expect(callback.mock.calls[0]![0].responseHeaders).not.toHaveProperty('content-security-policy');
  await invoke('key', 'test-key');
  const cancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
        }),
    ),
  );
  await expect(invoke('refresh', true)).rejects.toThrow(/size limit/);
  expect(cancel).toHaveBeenCalledOnce();
  const streamCancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES));
              controller.enqueue(new Uint8Array(1));
            },
            cancel: streamCancel,
          }),
          { headers: { 'content-length': '1' } },
        ),
    ),
  );
  await expect(invoke('refresh', true)).rejects.toThrow(/size limit/);
  expect(streamCancel).toHaveBeenCalledOnce();
});
