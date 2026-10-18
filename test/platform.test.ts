import { describe, expect, it } from 'vitest';
import { platformAdapter } from '../src/renderer/platform/index.js';
import { windowOptions, linuxDataDir } from '../src/main/window.js';
import { targetHome } from '../src/main/service.js';
import path from 'node:path';
describe('platform boundaries', () => {
  it.each([
    ['darwin', 'mac', '⌘'],
    ['win32', 'windows', 'Ctrl'],
    ['linux', 'linux', 'Ctrl'],
  ])('adapts %s', (os, kind, modifier) => {
    const adapter = platformAdapter(os);
    expect(adapter.kind).toBe(kind);
    expect(adapter.modifier).toBe(modifier);
    expect(
      adapter.isSettingsShortcut({ key: ',', metaKey: os === 'darwin', ctrlKey: os !== 'darwin' }),
    ).toBe(true);
    expect(
      adapter.isSettingsShortcut({ key: ',', metaKey: os !== 'darwin', ctrlKey: os === 'darwin' }),
    ).toBe(false);
    const options = windowOptions(os, '/preload.cjs');
    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
  });
  it('uses native window materials and XDG settings', () => {
    expect(windowOptions('darwin', '').titleBarStyle).toBe('hiddenInset');
    expect(windowOptions('darwin', '').vibrancy).toBe('sidebar');
    expect(windowOptions('win32', '').backgroundMaterial).toBe('mica');
    expect(linuxDataDir('/synthetic', '/xdg')).toBe(path.join('/xdg', 'ensemble'));
    expect(linuxDataDir('/synthetic', 'relative')).toBe(
      path.join('/synthetic', '.config', 'ensemble'),
    );
  });
  it('uses a project sandbox in dev, explicit override in tests and real home only as packaged target', () => {
    expect(targetHome(false, '/real', '/checkout')).toBe(path.resolve('/checkout/.sandbox-home'));
    expect(targetHome(true, '/real', '/checkout', '/override')).toBe(path.resolve('/override'));
    expect(targetHome(true, '/real', '/checkout')).toBe(path.resolve('/real'));
    expect(() => targetHome(false, '/real', '/checkout', '../escape')).toThrow();
  });
});
