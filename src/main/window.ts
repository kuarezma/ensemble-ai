import type { BrowserWindowConstructorOptions } from 'electron';
import path from 'node:path';
export function windowOptions(platform: string, preload: string): BrowserWindowConstructorOptions {
  return {
    width: 1180,
    height: 820,
    minWidth: 360,
    minHeight: 560,
    show: false,
    title: 'Ensemble',
    backgroundColor: '#f7f8fa',
    ...(platform === 'darwin'
      ? ({
          titleBarStyle: 'hiddenInset',
          vibrancy: 'sidebar',
          visualEffectState: 'followWindow',
        } as const)
      : {}),
    ...(platform === 'win32' ? ({ backgroundMaterial: 'mica' } as const) : {}),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  };
}
export function linuxDataDir(home: string, xdg?: string) {
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config'), 'ensemble');
}
