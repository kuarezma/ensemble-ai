import { mkdir, open, readFile, rename, rm, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { absoluteRoot, assertSafePath, within } from './paths.js';
import { assertManagedOnlyChange, managedBlock } from './markers.js';
import { readOptional, writableTargets, type FileChange } from './writers.js';
export { buildApplyPreview, verifyToolTargets } from './writers.js';
export type { FileChange, ApplyPreview, ToolResult } from './writers.js';
const EntrySchema = z.object({
  path: z.string(),
  backup: z
    .string()
    .regex(/^\d+\.bak$/)
    .nullable(),
  beforeHash: z.string().nullable(),
  afterHash: z.string(),
  mode: z.number().int(),
});
const ManifestSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-zA-Z0-9-]+$/),
  status: z.enum(['prepared', 'applied', 'reverted', 'rolled-back']),
  entries: z.array(EntrySchema),
  warnings: z.array(z.string()).default([]),
});
export type Manifest = z.infer<typeof ManifestSchema>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function contentHash(file: string) {
  const content = await readOptional(file);
  return content === null ? null : hash(content);
}
export class ApplyRecoveryError extends Error {
  constructor(
    message: string,
    public readonly manifestId: string,
    cause: unknown,
  ) {
    super(message, { cause });
  }
}
export async function listRecoveryManifests(homeDir: string): Promise<Manifest[]> {
  const home = absoluteRoot(homeDir),
    dir = path.join(home, '.ensemble', 'backups');
  let names: string[];
  try {
    // Validate a child to check every ancestor without treating the directory as a file.
    await assertSafePath(home, path.join(dir, '.scan'));
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const manifests: Manifest[] = [];
  for (const name of names.sort().reverse()) {
    if (!/^[a-zA-Z0-9-]+$/.test(name)) continue;
    try {
      const file = path.join(dir, name, 'manifest.json');
      await assertSafePath(home, file);
      const parsed = ManifestSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
      if (
        parsed.success &&
        parsed.data.id === name &&
        (parsed.data.status === 'applied' || parsed.data.status === 'prepared')
      )
        manifests.push(parsed.data);
    } catch {
      // A damaged or unsafe transaction must not hide other recovery candidates.
    }
  }
  return manifests;
}
function authorizedRoot(file: string, home: string, projects: string[]): string {
  if (!path.isAbsolute(file)) throw new Error('Absolute target path required');
  const root = [home, ...projects.map(absoluteRoot)].find((root) => within(root, file));
  if (!root || within(path.join(home, '.ensemble'), file))
    throw new Error('Unauthorized target path');
  if (!writableTargets(home, projects).has(file)) throw new Error('Unauthorized writer target');
  return root;
}
async function atomicWrite(
  root: string,
  file: string,
  content: string,
  mode = 0o600,
  expected?: string | null,
) {
  await assertSafePath(root, file);
  const expectedHash = expected === undefined ? await contentHash(file) : expected;
  await mkdir(path.dirname(file), { recursive: true });
  await assertSafePath(root, file);
  const temp = path.join(path.dirname(file), `.ensemble-${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, 'wx', mode);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertSafePath(root, file);
    if ((await contentHash(file)) !== expectedHash)
      throw new Error('File changed just before rename: ' + path.basename(file));
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
async function removeOwnedLock(lock: string, inode: number) {
  try {
    if ((await stat(lock)).ino === inode) await rm(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
async function withLock<T>(homeDir: string, action: (home: string) => Promise<T>): Promise<T> {
  const home = absoluteRoot(homeDir);
  const lock = path.join(home, '.ensemble', 'apply.lock');
  await assertSafePath(home, lock);
  await mkdir(path.dirname(lock), { recursive: true });
  await assertSafePath(home, lock);
  let handle;
  try {
    handle = await open(lock, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const observed = await stat(lock);
    let stale = Date.now() - observed.mtimeMs > 10 * 60 * 1000;
    try {
      const owner = z
        .object({ pid: z.number().int().positive(), createdAt: z.iso.datetime() })
        .parse(JSON.parse(await readFile(lock, 'utf8')));
      stale ||= Date.now() - Date.parse(owner.createdAt) > 10 * 60 * 1000;
      try {
        process.kill(owner.pid, 0);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === 'ESRCH') stale = true;
        else if ((failure as NodeJS.ErrnoException).code !== 'EPERM') throw failure;
      }
    } catch (failure) {
      if (!(failure instanceof SyntaxError) && !(failure instanceof z.ZodError)) throw failure;
    }
    if (!stale) throw new Error('Apply lock is active');
    // Recheck the observed lock before removing it.
    const current = await stat(lock);
    if (current.ino !== observed.ino || current.mtimeMs !== observed.mtimeMs)
      throw new Error('Apply lock changed; retry');
    await rm(lock);
    handle = await open(lock, 'wx', 0o600);
  }
  const ownership = await handle.stat();
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n',
    );
    return await action(home);
  } finally {
    await handle.close();
    await removeOwnedLock(lock, ownership.ino);
  }
}
export async function verify(changes: FileChange[]): Promise<boolean> {
  for (const change of changes) {
    await assertSafePath(change.root, change.path);
    const content = await readFile(change.path, 'utf8');
    if (content !== change.after || managedBlock(content) === null) return false;
  }
  return true;
}
export async function applyChanges(
  changes: FileChange[],
  homeDir: string,
  projectDirs: string[] = [],
): Promise<Manifest | null> {
  if (!changes.length) return null;
  return withLock(homeDir, async (home) => {
    if (new Set(changes.map((c) => c.path)).size !== changes.length)
      throw new Error('Duplicate target path');
    for (const change of changes) {
      const root = authorizedRoot(change.path, home, projectDirs);
      await assertSafePath(root, change.path);
      if ((await readOptional(change.path)) !== change.before)
        throw new Error('File changed since preview: ' + path.basename(change.path));
      assertManagedOnlyChange(
        change.before,
        change.after,
        /[/\\]\.claude[/\\]agents[/\\]ensemble-[a-z]+\.md$/.test(change.path),
      );
    }
    const id = new Date().toISOString().replace(/[^0-9]/g, '') + '-' + randomUUID();
    const dir = path.join(home, '.ensemble', 'backups', id);
    const manifestFile = path.join(dir, 'manifest.json');
    await assertSafePath(home, manifestFile);
    await mkdir(dir, { recursive: true });
    const manifest: Manifest = { version: 1, id, status: 'prepared', entries: [], warnings: [] };
    for (const change of changes)
      if (change.before !== null && (await stat(change.path)).nlink > 1)
        manifest.warnings.push(`Hard-linked target will be replaced independently: ${change.path}`);
    for (const [i, change] of changes.entries()) {
      const backup = change.before === null ? null : `${i}.bak`;
      const mode = change.before === null ? 0o600 : (await stat(change.path)).mode & 0o777;
      if (backup) await atomicWrite(home, path.join(dir, backup), change.before!);
      manifest.entries.push({
        path: change.path,
        backup,
        beforeHash: change.before === null ? null : hash(change.before),
        afterHash: hash(change.after),
        mode,
      });
    }
    const saveManifest = () =>
      atomicWrite(home, manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    // Durable recovery information exists before any target is modified.
    await saveManifest();
    const applied: number[] = [];
    try {
      for (const [i, change] of changes.entries()) {
        const root = authorizedRoot(change.path, home, projectDirs);
        if ((await readOptional(change.path)) !== change.before)
          throw new Error('File changed during apply');
        await atomicWrite(
          root,
          change.path,
          change.after,
          manifest.entries[i]!.mode,
          change.before === null ? null : hash(change.before),
        );
        applied.push(i);
      }
      if (!(await verify(changes))) throw new Error('Write verification failed');
      manifest.status = 'applied';
      await saveManifest();
      return manifest;
    } catch (error) {
      try {
        for (const i of applied.reverse()) {
          const change = changes[i]!;
          const root = authorizedRoot(change.path, home, projectDirs);
          await assertSafePath(root, change.path);
          if ((await readOptional(change.path)) !== change.after)
            throw new Error('Rollback conflict; use prepared manifest after resolving edits', {
              cause: error,
            });
          if (change.before === null) await rm(change.path, { force: true });
          else
            await atomicWrite(
              root,
              change.path,
              change.before,
              manifest.entries[i]!.mode,
              hash(change.after),
            );
        }
        manifest.status = 'rolled-back';
        await saveManifest();
      } catch (rollbackError) {
        throw new ApplyRecoveryError(
          'Apply interrupted; recovery required: ' +
            (rollbackError instanceof Error ? rollbackError.message : 'Rollback failed'),
          id,
          rollbackError,
        );
      }
      throw new ApplyRecoveryError(
        error instanceof Error ? error.message : 'Apply failed',
        id,
        error,
      );
    }
  });
}
export async function revert(
  manifestId: string,
  homeDir: string,
  projectDirs: string[] = [],
): Promise<Manifest> {
  if (!/^[a-zA-Z0-9-]+$/.test(manifestId)) throw new Error('Invalid manifest ID');
  return withLock(homeDir, async (home) => {
    const dir = path.join(home, '.ensemble', 'backups', manifestId),
      file = path.join(dir, 'manifest.json');
    await assertSafePath(home, file);
    const manifest = ManifestSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    if (manifest.id !== manifestId) throw new Error('Manifest ID mismatch');
    if (manifest.status === 'reverted' || manifest.status === 'rolled-back') return manifest;
    const restore: { entry: Manifest['entries'][number]; root: string; before: string | null }[] =
      [];
    for (const entry of manifest.entries) {
      const root = authorizedRoot(entry.path, home, projectDirs);
      await assertSafePath(root, entry.path);
      let before: string | null = null;
      if (entry.backup) {
        const backup = path.join(dir, entry.backup);
        await assertSafePath(home, backup);
        before = await readFile(backup, 'utf8');
      }
      if ((before === null ? null : hash(before)) !== entry.beforeHash)
        throw new Error('Backup checksum mismatch');
      const current = await readOptional(entry.path),
        currentHash = current === null ? null : hash(current);
      if (currentHash !== entry.afterHash && currentHash !== entry.beforeHash)
        throw new Error('Revert conflict: file edited after apply');
      if (currentHash !== entry.beforeHash) restore.push({ entry, root, before });
    }
    // All conflicts checked before restoring any target. Prepared manifests recover interrupted applies.
    for (const { entry, root, before } of restore.reverse()) {
      await assertSafePath(root, entry.path);
      const current = await readOptional(entry.path);
      if (current === null || hash(current) !== entry.afterHash)
        throw new Error('File changed during revert');
      if (before === null) await rm(entry.path, { force: true });
      else await atomicWrite(root, entry.path, before, entry.mode, entry.afterHash);
    }
    manifest.status = 'reverted';
    await atomicWrite(home, file, JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  });
}
