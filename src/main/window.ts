import type { BrowserWindowConstructorOptions } from 'electron';
import path from 'node:path';
/** Matches --bg in styles.css so the first painted frame never flashes the wrong theme. */
const BACKGROUND = { light: '#f8f9fb', dark: '#14181f' } as const;
export function windowOptions(
  platform: string,
  preload: string,
  dark = false,
): BrowserWindowConstructorOptions {
  return {
    width: 1180,
    height: 820,
    minWidth: 360,
    minHeight: 560,
    // macOS paints the native vibrant frame at once; other platforms wait for the first paint.
    show: platform === 'darwin',
    title: 'Ensemble',
    backgroundColor: dark ? BACKGROUND.dark : BACKGROUND.light,
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
