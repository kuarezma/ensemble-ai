import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createService } from '../src/main/service.js';
import { input, tempHome } from './helpers.js';
describe('main IPC service', () => {
  it('plans and previews without writing, rejects arbitrary IDs, applies once and reverts', async () => {
    const home = await tempHome(),
      service = createService(home);
    await expect(service.preview(['codex-cli'])).rejects.toThrow();
    service.plan(input());
    const preview = await service.preview(['codex-cli']);
    expect(await readdir(home)).toEqual([]);
    expect(preview.files[0]?.path).not.toContain(home);
    await expect(service.apply('not-a-uuid')).rejects.toThrow();
    const result = await service.apply(preview.id);
    expect(result.verified).toBe(true);
    expect(result.manifestId).toBeTruthy();
    await expect(service.apply(preview.id)).rejects.toThrow('Preview expired');
    await service.revert(result.manifestId!);
    expect(await readdir(home)).toEqual(['.codex', '.ensemble']);
  });
  it('invalidates previews on replanning and preserves concurrent external edits', async () => {
    const home = await tempHome(),
      service = createService(home);
    service.plan(input());
    const old = await service.preview(['codex-cli']);
    service.plan(input('quality'));
    await expect(service.apply(old.id)).rejects.toThrow('Preview expired');
    const preview = await service.preview(['codex-cli']);
    await mkdir(path.join(home, '.codex'));
    const target = path.join(home, '.codex/AGENTS.md');
    await writeFile(target, 'User edits\n');
    await expect(service.apply(preview.id)).rejects.toThrow('File changed since preview');
    expect(await readFile(target, 'utf8')).toBe('User edits\n');
  });
  it('rejects unknown tools and overlapping mutations, and preserves pending preview across agents-md export', async () => {
    const service = createService(await tempHome());
    service.plan(input());
    await expect(service.preview(['unknown'])).rejects.toThrow();
    const pending = service.preview(['codex-cli']);
    expect(() => service.plan(input())).toThrow('Operation in progress');
    const filePreview = await pending;
    const exportPreview = await service.preview(['agents-md']);
    expect(exportPreview.exports).toHaveLength(1);
    const applied = await service.apply(filePreview.id);
    expect(applied.verified).toBe(true);
  });
});

import { pathToFileURL } from 'node:url';
import { trustedRendererURL } from '../src/main/security.js';
it('trusts only the packaged renderer URL, preserving spaces and Unicode', () => {
  const renderer = path.resolve('a # ü/index.html');
  expect(trustedRendererURL(pathToFileURL(renderer).href, renderer)).toBe(true);
  expect(trustedRendererURL(pathToFileURL(renderer).href + '?injected', renderer)).toBe(false);
  expect(trustedRendererURL('https://untrusted.example', renderer)).toBe(false);
  expect(trustedRendererURL('not a URL', renderer, 'http://localhost:5173')).toBe(false);
  expect(trustedRendererURL('http://localhost:5173/', renderer, 'http://localhost:5173')).toBe(
    true,
  );
  expect(trustedRendererURL('http://localhost:5174/', renderer, 'http://localhost:5173')).toBe(
    false,
  );
});
