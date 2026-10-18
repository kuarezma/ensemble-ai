import { afterEach, describe, expect, it, vi } from 'vitest';
const fault = vi.hoisted(() => ({ lateEdit: '', failTarget: '', conflictTarget: '' }));
vi.mock('../src/core/engine/index.js', async () => ({
  generatePlan: (await import('./phase-d-fixtures.js')).recoveryPlan,
}));
vi.mock('../src/core/catalog.js', async () => {
  const fixture = await import('./phase-d-fixtures.js');
  const { readFileSync } = await import('node:fs');
  return {
    models: fixture.recoveryModels,
    tools: fixture.recoveryTools,
    subscriptions: fixture.recoverySubscriptions,
    teamTemplate: readFileSync(
      new URL('../catalog/rules-template/team.md', import.meta.url),
      'utf8',
    ),
  };
});
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (
        fault.lateEdit &&
        String(args[0]).startsWith(path.dirname(fault.lateEdit) + path.sep) &&
        String(args[0]).endsWith('.tmp')
      ) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          const file = fault.lateEdit;
          fault.lateEdit = '';
          await fs.writeFile(file, 'Late external edit');
        };
      }
      return handle;
    },
    rename: async (from: string, to: string) => {
      if (to === fault.failTarget) {
        fault.failTarget = '';
        if (fault.conflictTarget) await fs.writeFile(fault.conflictTarget, 'External edit');
        throw new Error('Injected rename failure');
      }
      return fs.rename(from, to);
    },
  };
});
import path from 'node:path';
import { access, link, mkdir, readFile, readdir, writeFile, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { applyChanges, buildApplyPreview, revert } from '../src/core/apply/index.js';
import { createService } from '../src/main/service.js';
import { input, tempHome } from './helpers.js';
import { recoveryPlan } from './phase-d-fixtures.js';
afterEach(() => {
  vi.restoreAllMocks();
  fault.lateEdit = fault.failTarget = fault.conflictTarget = '';
});
async function lockFile(home: string, data: unknown) {
  await mkdir(path.join(home, '.ensemble'), { recursive: true });
  const file = path.join(home, '.ensemble/apply.lock');
  await writeFile(file, JSON.stringify(data));
  return file;
}
describe('stale apply locks', () => {
  it('reclaims a dead PID and writes PID plus timestamp while holding the lock', async () => {
    const home = await tempHome();
    await lockFile(home, { pid: 123456789, createdAt: new Date().toISOString() });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'ESRCH' });
    });
    const changes = await buildApplyPreview(recoveryPlan(), ['codex-cli'], home);
    await applyChanges(changes, home);
    expect(kill).toHaveBeenCalledWith(123456789, 0);
    await expect(access(path.join(home, '.ensemble/apply.lock'))).rejects.toThrow();
  });
  it('reclaims locks older than ten minutes even when the PID is alive', async () => {
    const home = await tempHome();
    await lockFile(home, {
      pid: process.pid,
      createdAt: new Date(Date.now() - 601_000).toISOString(),
    });
    await expect(
      applyChanges(await buildApplyPreview(recoveryPlan(), ['codex-cli'], home), home),
    ).resolves.toBeTruthy();
  });
  it('preserves a fresh active or EPERM lock and reclaims old malformed locks', async () => {
    const home = await tempHome();
    const file = await lockFile(home, { pid: process.pid, createdAt: new Date().toISOString() });
    const changes = await buildApplyPreview(recoveryPlan(), ['codex-cli'], home);
    await expect(applyChanges(changes, home)).rejects.toThrow(/active/);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'EPERM' });
    });
    await expect(applyChanges(changes, home)).rejects.toThrow(/active/);
    await writeFile(file, 'incomplete');
    const old = new Date(Date.now() - 601_000);
    await utimes(file, old, old);
    await expect(applyChanges(changes, home)).resolves.toBeTruthy();
  });
});
it.each([true, false])(
  'preserves late external edits just before rename (existing=%s)',
  async (existing) => {
    const home = await tempHome(),
      file = path.join(home, '.codex/AGENTS.md');
    if (existing) {
      await mkdir(path.dirname(file));
      await writeFile(file, 'Original');
    }
    const changes = await buildApplyPreview(recoveryPlan(), ['codex-cli'], home);
    fault.lateEdit = file;
    await expect(applyChanges(changes, home)).rejects.toThrow(/changed just before rename/);
    expect(await readFile(file, 'utf8')).toBe('Late external edit');
    expect((await readdir(path.dirname(file))).some((name) => name.endsWith('.tmp'))).toBe(false);
  },
);
it('protects a late external edit during revert and leaves the transaction recoverable', async () => {
  const home = await tempHome(),
    file = path.join(home, '.codex/AGENTS.md');
  await mkdir(path.dirname(file));
  await writeFile(file, 'Original');
  const manifest = (await applyChanges(
    await buildApplyPreview(recoveryPlan(), ['codex-cli'], home),
    home,
  ))!;
  fault.lateEdit = file;
  await expect(revert(manifest.id, home)).rejects.toThrow(/changed just before rename/);
  expect(await readFile(file, 'utf8')).toBe('Late external edit');
  expect((await createService(home).recoveries()).some((item) => item.id === manifest.id)).toBe(
    true,
  );
});

it('warns for hard links, applies successfully and preserves the other linked copy', async () => {
  const home = await tempHome(),
    file = path.join(home, '.codex/AGENTS.md'),
    other = path.join(home, 'other.md');
  await mkdir(path.dirname(file));
  await writeFile(file, 'Original');
  await link(file, other);
  const changes = await buildApplyPreview(recoveryPlan(), ['codex-cli'], home);
  expect(changes.warnings).toHaveLength(1);
  const manifest = (await applyChanges(changes, home))!;
  expect(manifest.warnings).toHaveLength(1);
  expect(await readFile(other, 'utf8')).toBe('Original');
  await revert(manifest.id, home);
  expect(await readFile(file, 'utf8')).toBe('Original');
});
it('lists only valid applied/prepared manifests and reverts after service restart', async () => {
  const home = await tempHome();
  const manifest = (await applyChanges(
    await buildApplyPreview(recoveryPlan(), ['codex-cli'], home),
    home,
  ))!;
  const dir = path.join(home, '.ensemble/backups');
  for (const [id, data] of Object.entries({
    malformed: '{',
    invalid: '{}',
    mismatch: JSON.stringify(manifest),
    prepared: JSON.stringify({ ...manifest, id: 'prepared', status: 'prepared' }),
    reverted: JSON.stringify({ ...manifest, id: 'reverted', status: 'reverted' }),
  })) {
    await mkdir(path.join(dir, id));
    await writeFile(path.join(dir, id, 'manifest.json'), data);
  }
  const service = createService(home);
  expect((await service.recoveries()).map((m) => m.id).sort()).toEqual(
    [manifest.id, 'prepared'].sort(),
  );
  await service.revert(manifest.id);
  await expect(access(path.join(home, '.codex/AGENTS.md'))).rejects.toThrow();
});
it('returns a prepared manifest ID across IPC when partial apply cannot roll back', async () => {
  const home = await tempHome(),
    service = createService(home);
  service.plan(input());
  const preview = await service.preview(['codex-cli', 'gemini-cli']);
  const first = path.join(home, preview.files[0]!.path),
    second = path.join(home, preview.files[1]!.path);
  fault.failTarget = second;
  fault.conflictTarget = first;
  const result = await service.apply(preview.id);
  expect(result.verified).toBe(false);
  expect(result.manifestId).toBeTruthy();
  const saved = (await createService(home).recoveries()).find((m) => m.id === result.manifestId)!;
  expect(saved.status).toBe('prepared');
  expect(await readFile(first, 'utf8')).toBe('External edit');
  await expect(createService(home).revert(saved.id)).rejects.toThrow(/conflict/);
});
it('rejects hand-edited manifests pointing to arbitrary HOME files before deleting any target', async () => {
  const home = await tempHome();
  const manifest = (await applyChanges(
    await buildApplyPreview(recoveryPlan(), ['codex-cli'], home),
    home,
  ))!;
  const file = path.join(home, 'personal.txt');
  await writeFile(file, 'Personal');
  manifest.entries.push({
    path: file,
    backup: null,
    beforeHash: null,
    afterHash: createHash('sha256').update('Personal').digest('hex'),
    mode: 0o600,
  });
  await writeFile(
    path.join(home, '.ensemble/backups', manifest.id, 'manifest.json'),
    JSON.stringify(manifest),
  );
  await expect(revert(manifest.id, home)).rejects.toThrow(/Unauthorized writer/);
  expect(await readFile(file, 'utf8')).toBe('Personal');
  await expect(access(manifest.entries[0]!.path)).resolves.toBeUndefined();
});
