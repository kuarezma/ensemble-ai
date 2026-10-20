import { describe, expect, it } from 'vitest';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyChanges,
  buildApplyPreview,
  revert,
  verifyToolTargets,
} from '../src/core/apply/index.js';
import { managedBlock } from '../src/core/apply/markers.js';
import { createService } from '../src/main/service.js';
import { input, plan, tempHome } from './helpers.js';
const crew = ['claude-code', 'codex-cli', 'gemini-cli', 'opencode', 'antigravity'];
const globalFiles: Record<string, string> = {
  'claude-code': '.claude/CLAUDE.md',
  'codex-cli': '.codex/AGENTS.md',
  'gemini-cli': '.gemini/GEMINI.md',
  opencode: '.config/opencode/AGENTS.md',
  antigravity: '.gemini/AGENTS.md',
};
describe('persistent global rules in a sandbox HOME', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'writes, rereads and reverts every crew tool global file on %s',
    async (platform) => {
      const home = await tempHome(),
        current = plan();
      const preview = await buildApplyPreview(current, crew, home, [], platform);
      expect(preview.exports).toEqual([]);
      const manifest = (await applyChanges(preview, home))!;
      const results = await verifyToolTargets(current, crew, home, platform);
      expect(results.map((r) => [r.tool, r.status])).toEqual(crew.map((id) => [id, 'written']));
      for (const id of crew) {
        const file = path.join(home, globalFiles[id]!);
        expect(results.find((r) => r.tool === id)?.path).toBe(file);
        const block = managedBlock(await readFile(file, 'utf8'));
        expect(block).toContain('| builder |');
      }
      await revert(manifest.id, home);
      for (const id of crew)
        await expect(access(path.join(home, globalFiles[id]!))).rejects.toThrow();
    },
  );
  it('reports skipped copy-only tools and visible errors for missing or foreign blocks', async () => {
    const home = await tempHome(),
      current = plan();
    await applyChanges(await buildApplyPreview(current, ['codex-cli', 'antigravity'], home), home);
    await writeFile(path.join(home, '.codex/AGENTS.md'), 'User replaced the file\n');
    const results = await verifyToolTargets(
      current,
      ['codex-cli', 'antigravity', 'gemini-cli', 'cursor'],
      home,
    );
    expect(results.map((r) => [r.tool, r.status])).toEqual([
      ['codex-cli', 'error'],
      ['antigravity', 'error'],
      ['gemini-cli', 'error'],
      ['cursor', 'skipped'],
    ]);
    expect(results[0]!.detail).toBe('Ensemble block missing');
    // Peers differ from the applied selection, so the stored block no longer matches.
    expect(results[1]!.detail).toBe('Ensemble block does not match this crew');
    expect(results[2]!.detail).toBe('File missing after apply');
    expect(results[3]!.path).toBeNull();
  });
  it('returns one home-relative row per selected tool from the IPC service', async () => {
    const home = await tempHome(),
      service = createService(home);
    service.plan(input());
    const preview = await service.preview([...crew, 'cursor']);
    const result = await service.apply(preview.id);
    expect(result.verified).toBe(true);
    expect(result.tools).toEqual([
      ...crew.map((tool) => ({ tool, path: '~/' + globalFiles[tool], status: 'written' })),
      { tool: 'cursor', path: null, status: 'skipped', detail: 'No global rules file' },
    ]);
  });
});
