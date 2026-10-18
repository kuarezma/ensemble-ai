export type Platform = 'mac' | 'windows' | 'linux';
export function platformAdapter(platform: string) {
  const kind: Platform = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux';
  return {
    kind,
    modifier: kind === 'mac' ? '⌘' : 'Ctrl',
    settingsShortcut: kind === 'mac' ? '⌘ ,' : 'Ctrl ,',
    isSettingsShortcut: (event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey'>) =>
      event.key === ',' && (kind === 'mac' ? event.metaKey : event.ctrlKey),
  };
}
