import { vi, it, expect } from 'vitest';
const fault = vi.hoisted(() => ({ target: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      if (to === fault.target) {
        fault.target = '';
        throw new Error('Simulated target write failure');
      }
      return fs.rename(from, to);
    },
  };
});
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyChanges, buildApplyPreview } from '../src/core/apply/index.js';
import { tempHome, plan } from './helpers.js';
it('rolls back already-written targets and retains backups after a later write fails', async () => {
  const home = await tempHome();
  await mkdir(path.join(home, '.codex'));
  await writeFile(path.join(home, '.codex/AGENTS.md'), 'Keep original');
  const changes = await buildApplyPreview(plan(), ['codex-cli', 'gemini-cli'], home);
  fault.target = changes[1]!.path;
  await expect(applyChanges(changes, home)).rejects.toThrow(/Simulated/);
  expect(await readFile(changes[0]!.path, 'utf8')).toBe('Keep original');
  const ids = await readdir(path.join(home, '.ensemble/backups'));
  const manifest = JSON.parse(
    await readFile(path.join(home, '.ensemble/backups', ids[0]!, 'manifest.json'), 'utf8'),
  );
  expect(manifest.status).toBe('rolled-back');
});
