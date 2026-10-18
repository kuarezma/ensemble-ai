import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile, access, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { applyChanges, buildApplyPreview, revert, verify } from '../src/core/apply/index.js';
import { BEGIN, END, updateManagedBlock } from '../src/core/apply/markers.js';
import { resolveToolPath } from '../src/core/apply/paths.js';
import { plan, tempHome } from './helpers.js';
async function existing(home: string, text: string) {
  const file = path.join(home, '.codex/AGENTS.md');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}
describe('managed blocks', () => {
  it('is idempotent and preserves both sides byte for byte', () => {
    const before = 'Prefix ü\n' + BEGIN + '\nold\n' + END + '\nSuffix 世界';
    const after = updateManagedBlock(before, 'new $&');
    expect(after).toBe('Prefix ü\n' + BEGIN + '\nnew $&\n' + END + '\nSuffix 世界');
    expect(updateManagedBlock(after, 'new $&')).toBe(after);
  });
  it('preserves CRLF and trailing whitespace outside the block', () => {
    const before = 'Keep  \r\n' + BEGIN + '\r\nold\r\n' + END + '\r\nTail\r\n';
    const after = updateManagedBlock(before, 'new\nlines');
    expect(after).not.toMatch(/(?<!\r)\n/);
    expect(after.endsWith('Tail\r\n')).toBe(true);
  });
  it.each([BEGIN, END, END + BEGIN, BEGIN + END + BEGIN + END, '<!-- ENSEMBLE:BEGIN v2 -->'])(
    'rejects damaged or ambiguous markers %s',
    (text) => {
      expect(() => updateManagedBlock(text, 'new')).toThrow();
    },
  );
});
describe('file pipeline in synthetic HOME only', () => {
  it('dry-run does not create files, backups or directories', async () => {
    const home = await tempHome();
    const preview = await buildApplyPreview(plan(), ['codex-cli'], home);
    expect(preview.length).toBe(1);
    expect(preview[0]!.diff).toContain('+++');
    await expect(access(path.join(home, '.ensemble'))).rejects.toThrow();
  });
  it('backs up, verifies and restores existing Unicode/CRLF content and permissions', async () => {
    const base = await tempHome(),
      home = path.join(base, 'öğretmen 世界');
    await mkdir(home);
    const original = 'Özel yönerge\r\nKeep this.\r\n',
      file = await existing(home, original);
    const originalMode = (await stat(file)).mode & 0o777;
    const preview = await buildApplyPreview(plan(), ['codex-cli'], home);
    const manifest = (await applyChanges(preview, home))!;
    expect(await verify(preview)).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(originalMode);
    expect(await readFile(path.join(home, '.ensemble/backups', manifest.id, '0.bak'), 'utf8')).toBe(
      original,
    );
    expect(await buildApplyPreview(plan(), ['codex-cli'], home)).toHaveLength(0);
    await revert(manifest.id, home);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect((await revert(manifest.id, home)).status).toBe('reverted');
  });
  it('creates missing files and removes them on revert', async () => {
    const home = await tempHome();
    const changes = await buildApplyPreview(plan(), ['codex-cli'], home);
    const m = (await applyChanges(changes, home))!;
    expect(changes[0]!.before).toBeNull();
    await revert(m.id, home);
    await expect(access(changes[0]!.path)).rejects.toThrow();
  });
  it('writes all six Claude subagents with valid frontmatter first, idempotence and revert', async () => {
    const home = await tempHome();
    const changes = await buildApplyPreview(plan(), ['claude-code'], home);
    expect(changes).toHaveLength(7);
    const m = (await applyChanges(changes, home))!;
    const agent = await readFile(path.join(home, '.claude/agents/ensemble-builder.md'), 'utf8');
    expect(agent.startsWith('---\n# ENSEMBLE:BEGIN v1\nname:')).toBe(true);
    expect(agent).toMatch(/\nmodel: ".+"\neffort: ".+"/);
    expect(await buildApplyPreview(plan(), ['claude-code'], home)).toHaveLength(0);
    await revert(m.id, home);
    await expect(access(path.join(home, '.claude/agents/ensemble-builder.md'))).rejects.toThrow();
  });
  it('updates agent assignments only inside managed YAML and Markdown blocks', async () => {
    const home = await tempHome(),
      p = plan();
    const first = (await applyChanges(await buildApplyPreview(p, ['claude-code'], home), home))!;
    const file = path.join(home, '.claude/agents/ensemble-builder.md');
    const before = await readFile(file, 'utf8');
    await writeFile(file, before + '\nPersonal tail\n');
    p.assignments.builder = {
      model: 'claude-sonnet-5-5',
      effort: 'low',
      via: 'claude-code',
      why: ['New valid assignment'],
    };
    const preview = await buildApplyPreview(p, ['claude-code'], home);
    await applyChanges(preview, home);
    expect(await readFile(file, 'utf8')).toContain('effort: "low"');
    expect((await readFile(file, 'utf8')).endsWith('\nPersonal tail\n')).toBe(true);
    await expect(revert(first.id, home)).rejects.toThrow(/conflict/);
  });
  it('protects existing unmanaged agent files', async () => {
    const home = await tempHome();
    await mkdir(path.join(home, '.claude/agents'), { recursive: true });
    await writeFile(
      path.join(home, '.claude/agents/ensemble-builder.md'),
      '---\nname: custom\n---\nKeep',
    );
    await expect(buildApplyPreview(plan(), ['claude-code'], home)).rejects.toThrow(/unmanaged/);
  });
  it('refuses stale previews before creating backups or modifying targets', async () => {
    const home = await tempHome(),
      file = await existing(home, 'one');
    const changes = await buildApplyPreview(plan(), ['codex-cli'], home);
    await writeFile(file, 'two');
    await expect(applyChanges(changes, home)).rejects.toThrow(/changed since preview/);
    expect(await readFile(file, 'utf8')).toBe('two');
  });
  it('revert refuses subsequent user edits without clobbering them', async () => {
    const home = await tempHome();
    const changes = await buildApplyPreview(plan(), ['codex-cli'], home),
      m = (await applyChanges(changes, home))!;
    await writeFile(changes[0]!.path, 'user edit');
    await expect(revert(m.id, home)).rejects.toThrow(/conflict/);
    expect(await readFile(changes[0]!.path, 'utf8')).toBe('user edit');
  });
  it('detects tampered backups before any revert write', async () => {
    const home = await tempHome();
    await existing(home, 'original');
    const changes = await buildApplyPreview(plan(), ['codex-cli'], home),
      m = (await applyChanges(changes, home))!;
    await writeFile(path.join(home, '.ensemble/backups', m.id, '0.bak'), 'tamper');
    await expect(revert(m.id, home)).rejects.toThrow(/checksum/);
    expect(await verify(changes)).toBe(true);
  });
  it('exports rules for unverified tools without speculative file writes', async () => {
    const home = await tempHome(),
      preview = await buildApplyPreview(plan(), ['cursor', 'warp'], home);
    expect(preview).toHaveLength(0);
    expect(preview.exports).toHaveLength(2);
    expect(await applyChanges(preview, home)).toBeNull();
  });
  it('supports explicitly selected project AGENTS export and checks project authorization on apply/revert', async () => {
    const home = await tempHome(),
      project = await tempHome();
    const changes = await buildApplyPreview(plan(), ['agents-md'], home, [project]);
    await expect(applyChanges(changes, home)).rejects.toThrow(/Unauthorized/);
    const m = (await applyChanges(changes, home, [project]))!;
    await expect(revert(m.id, home)).rejects.toThrow(/Unauthorized/);
    await revert(m.id, home, [project]);
  });
  it('rejects symlink targets and symlink backup locations', async () => {
    const home = await tempHome(),
      outside = await tempHome();
    await symlink(outside, path.join(home, '.codex'), 'dir');
    await expect(buildApplyPreview(plan(), ['codex-cli'], home)).rejects.toThrow(/Symlink/);
    const another = await tempHome();
    await symlink(outside, path.join(another, '.ensemble'), 'dir');
    const changes = await buildApplyPreview(plan(), ['codex-cli'], another);
    await expect(applyChanges(changes, another)).rejects.toThrow(/Symlink/);
  });
  it('rejects path traversal and resolves Windows placeholders from the supplied home', async () => {
    const home = await tempHome();
    expect(() => resolveToolPath(home, '../escape')).toThrow(/escapes/);
    expect(() => resolveToolPath(home, '/etc/passwd')).toThrow(/Absolute/);
    expect(resolveToolPath(home, '%USERPROFILE%\\.codex\\AGENTS.md')).toBe(
      path.join(home, '.codex/AGENTS.md'),
    );
    expect(resolveToolPath(home, '%APPDATA%\\Tool\\rules.md')).toBe(
      path.join(home, 'AppData/Roaming/Tool/rules.md'),
    );
    await expect(revert('../escape', home)).rejects.toThrow(/Invalid/);
  });
  it('rejects concurrent applies with an exclusive lock', async () => {
    const home = await tempHome(),
      changes = await buildApplyPreview(plan(), ['codex-cli'], home);
    const results = await Promise.allSettled([
      applyChanges(changes, home),
      applyChanges(changes, home),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
  it('rejects proposals that modify unmanaged text even with valid markers', async () => {
    const home = await tempHome();
    const file = await existing(home, 'Personal text\n');
    const changes = await buildApplyPreview(plan(), ['codex-cli'], home);
    changes[0]!.after = changes[0]!.after.replace('Personal text', 'Tampered');
    await expect(applyChanges(changes, home)).rejects.toThrow(/outside managed/);
    expect(await readFile(file, 'utf8')).toBe('Personal text\n');
  });
  it('recovers an interrupted apply from a prepared manifest', async () => {
    const home = await tempHome();
    await existing(home, 'Original');
    const changes = await buildApplyPreview(plan(), ['codex-cli'], home);
    const m = (await applyChanges(changes, home))!;
    const file = path.join(home, '.ensemble/backups', m.id, 'manifest.json');
    m.status = 'prepared';
    await writeFile(file, JSON.stringify(m));
    await revert(m.id, home);
    expect(await readFile(changes[0]!.path, 'utf8')).toBe('Original');
  });
  it('rejects invalid UTF-8 rather than corrupting unmanaged bytes', async () => {
    const home = await tempHome();
    const file = await existing(home, '');
    await writeFile(file, Buffer.from([0xff, 0xfe, 0x61]));
    await expect(buildApplyPreview(plan(), ['codex-cli'], home)).rejects.toThrow();
    expect(await readFile(file)).toEqual(Buffer.from([0xff, 0xfe, 0x61]));
  });
});
