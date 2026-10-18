import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
export function absoluteRoot(root: string): string {
  if (!path.isAbsolute(root) || path.parse(root).root === path.resolve(root))
    throw new Error('Explicit non-root absolute directory required');
  return path.resolve(root);
}
export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}
export function resolveToolPath(homeDir: string, template: string): string {
  const home = absoluteRoot(homeDir);
  // Use only the supplied synthetic HOME; never process.env.USERPROFILE/APPDATA.
  const relative = template
    .replace(/^~[/\\]|^%USERPROFILE%[/\\]/, '')
    .replace(/^%APPDATA%[/\\]/, 'AppData/Roaming/')
    .replaceAll('\\', '/');
  if (path.isAbsolute(relative) || /^[a-z]:/i.test(relative))
    throw new Error('Absolute catalog paths are forbidden');
  const target = path.resolve(home, relative);
  if (!within(home, target)) throw new Error('Path escapes supplied root');
  return target;
}
export async function assertSafePath(rootDir: string, targetPath: string): Promise<void> {
  const root = absoluteRoot(rootDir),
    target = path.resolve(targetPath);
  if (!within(root, target)) throw new Error('Path escapes supplied root');
  // Reject symlinks in every existing ancestor, including the root and parents.
  // realpath accommodates OS aliases such as macOS /var -> /private/var only above the explicit root.
  const actualRoot = await realpath(root);
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Symlink root rejected');
  let cursor = actualRoot;
  for (const part of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('Symlink target rejected');
      if (cursor !== path.join(actualRoot, path.relative(root, target)) && !stat.isDirectory())
        throw new Error('Non-directory ancestor');
      if (cursor === path.join(actualRoot, path.relative(root, target)) && !stat.isFile())
        throw new Error('Target is not a regular file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}
