import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCLI } from '../src/core/cli.js';
import { refreshAA, REFRESH_INTERVAL_MS } from '../src/core/aa/refresh.js';
import { input, plan, tempHome } from './helpers.js';
describe('headless CLI', () => {
  it('prints help, plans from validated access input, and rejects invalid flags', async () => {
    const out: string[] = [];
    await runCLI(['--help'], (t) => out.push(t));
    expect(out[0]).toContain('--dry-run');
    const home = await tempHome(),
      config = path.join(home, 'input.json');
    await writeFile(config, JSON.stringify(input()));
    await runCLI(['plan', '--config', config], (t) => out.push(t));
    expect(JSON.parse(out[1]!).plan.assignments.builder.model).toBeTruthy();
    await expect(runCLI(['--unexpected'])).rejects.toThrow();
  });
  it('runs dry-run, apply and revert with only explicit home and JSON config', async () => {
    const home = await tempHome(),
      config = path.join(home, 'plan.json');
    await writeFile(config, JSON.stringify({ plan: plan(), tools: ['codex-cli'] }));
    const out: string[] = [];
    const output = (t: string) => out.push(t);
    await expect(runCLI(['apply', '--config', config], output)).rejects.toThrow(/Explicit --home/);
    await runCLI(['apply', '--config', config, '--home', home, '--dry-run'], output);
    expect(JSON.parse(out[0]!).changes).toHaveLength(1);
    await expect(access(path.join(home, '.ensemble'))).rejects.toThrow();
    await runCLI(['apply', '--config', config, '--home', home], output);
    const id = JSON.parse(out[1]!).manifest.id;
    await runCLI(['revert', '--home', home, '--manifest-id', id], output);
    expect(JSON.parse(out[2]!).status).toBe('reverted');
  });
});
describe('optional AA refresh (offline mocked transport)', () => {
  it('does nothing without consent', async () => {
    const fetcher = vi.fn();
    expect(
      (await refreshAA({ consent: false, cacheDir: 'invalid-unused-path', known: [], fetcher }))
        .status,
    ).toBe('disabled');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('fetches politely, caches for 24 hours and diffs cached records without losing user edits', async () => {
    const home = await tempHome(),
      fixture = await readFile(new URL('fixtures/aa-payload.txt', import.meta.url), 'utf8');
    const fetcher = vi.fn(async () => new Response(fixture)),
      now = Date.UTC(2026, 9, 19);
    const options = { consent: true, cacheDir: home, known: [], fetcher, now };
    const result = await refreshAA(options);
    expect(result.status).toBe('refreshed');
    expect(result.requiresApproval).toBe(true);
    expect(fetcher.mock.calls).toHaveLength(1);
    const again = await refreshAA({ ...options, now: now + 1000 });
    expect(again.status).toBe('cached');
    expect(again.changes.length).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const approved = result.models.map((m) => ({
      ...m,
      availability: ['user-selected'],
      provisional: false,
    }));
    const approvedCache = await refreshAA({ ...options, known: approved, now: now + 2000 });
    expect(approvedCache.changes).toHaveLength(0);
    expect(approvedCache.models[0]!.availability).toEqual(['user-selected']);
    await refreshAA({ ...options, now: now + REFRESH_INTERVAL_MS });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not replace a good cache when the transport or parser fails', async () => {
    const home = await tempHome(),
      file = path.join(home, 'aa-cache.json');
    await writeFile(file, '{"bad":"cache"}');
    await expect(
      refreshAA({
        consent: true,
        cacheDir: home,
        known: [],
        fetcher: async () => new Response('offline', { status: 503 }),
      }),
    ).rejects.toThrow(/503/);
    expect(await readFile(file, 'utf8')).toBe('{"bad":"cache"}');
    await expect(
      refreshAA({
        consent: true,
        cacheDir: home,
        known: [],
        fetcher: async () => new Response('unknown payload'),
      }),
    ).rejects.toThrow(/No recognized/);
  });
});
