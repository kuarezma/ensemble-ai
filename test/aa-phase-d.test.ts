import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeAARecords, parseAAPayload } from '../src/core/aa/index.js';
import { MAX_RESPONSE_BYTES, readBoundedResponseText, refreshAA } from '../src/core/aa/refresh.js';

const temporaryDirectories: string[] = [];
async function tempHome() {
  await mkdir(path.resolve('.dev-data'), { recursive: true });
  const directory = await mkdtemp(path.resolve('.dev-data/aa-phase-d-'));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

const valid = {
  slug: 'valid-model-high',
  name: 'Valid Model',
  shortName: 'Valid',
  effort: { slug: 'high' },
  intelligenceIndex: 42,
};
const effortless = {
  ...valid,
  slug: 'unlabelled-model',
  effort: null,
  isReasoning: true,
};

describe('AA record isolation', () => {
  it('skips malformed, unknown-effort and effort-less rows and keeps later valid rows', () => {
    const result = mergeAARecords(
      [null, { ...valid, effort: { slug: 'invalid' } }, effortless, valid],
      [],
      '2026-10-19',
    );
    expect(result.models.map((model) => model.id)).toEqual(['valid-model']);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.join(' ')).toContain('Effort not declared');
    expect(mergeAARecords([effortless], [], '2026-10-19').changes).toEqual([]);
  });

  it('reports malformed payload rows, writes the cache and retains warnings on cache reads', async () => {
    const cacheDir = await tempHome();
    const payload = [
      JSON.stringify({ ...valid, shortName: null }),
      JSON.stringify(effortless),
      JSON.stringify(valid),
    ].join('\n');
    const parseWarnings: string[] = [];
    expect(parseAAPayload(payload, parseWarnings)).toHaveLength(2);
    expect(parseWarnings).toHaveLength(1);
    const fetcher = vi.fn(async () => new Response(payload));
    const options = { consent: true, cacheDir, known: [], fetcher, now: Date.now() };
    const result = await refreshAA(options);
    expect(result.status).toBe('refreshed');
    expect(result.models).toHaveLength(1);
    expect(result.warnings).toHaveLength(2);
    const cache = JSON.parse(await readFile(path.join(cacheDir, 'aa-cache.json'), 'utf8'));
    expect(cache.records).toHaveLength(2);
    const cached = await refreshAA(options);
    expect(cached.status).toBe('cached');
    expect(cached.warnings).toEqual(result.warnings);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('caches an entirely malformed recognized payload with warnings', async () => {
    const cacheDir = await tempHome();
    const result = await refreshAA({
      consent: true,
      cacheDir,
      known: [],
      fetcher: async () => new Response(JSON.stringify({ ...valid, shortName: null })),
    });
    expect(result.status).toBe('refreshed');
    expect(result.warnings).toHaveLength(1);
    expect(
      JSON.parse(await readFile(path.join(cacheDir, 'aa-cache.json'), 'utf8')).records,
    ).toEqual([]);
  });

  it('still caches a recognized payload when all rows lack declared effort', async () => {
    const cacheDir = await tempHome();
    const result = await refreshAA({
      consent: true,
      cacheDir,
      known: [],
      fetcher: async () => new Response(JSON.stringify(effortless)),
    });
    expect(result.status).toBe('refreshed');
    expect(result.models).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(
      JSON.parse(await readFile(path.join(cacheDir, 'aa-cache.json'), 'utf8')).records,
    ).toHaveLength(1);
  });
});

describe('bounded fetch response bodies', () => {
  it('rejects an oversized declared length before reading and cancels the body', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
    });
    await expect(readBoundedResponseText(response)).rejects.toThrow(/size limit/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([undefined, '1'])('cuts off a stream with content-length %s at 20 MB', async (length) => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024);
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(chunk);
      },
      cancel,
    });
    const response = new Response(stream, {
      headers: length === undefined ? {} : { 'content-length': length },
    });
    await expect(readBoundedResponseText(response)).rejects.toThrow(/size limit/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(reads).toBeLessThanOrEqual(22);
  });

  it('counts UTF-8 bytes and decodes multibyte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('şğ');
    const response = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(0, 1));
            controller.enqueue(bytes.slice(1));
            controller.close();
          },
        }),
      );
    await expect(readBoundedResponseText(response(), 4)).resolves.toBe('şğ');
    await expect(readBoundedResponseText(response(), 3)).rejects.toThrow(/size limit/);
  });

  it('applies the size limit to refresh and leaves an existing cache untouched', async () => {
    const cacheDir = await tempHome();
    const now = Date.now();
    await refreshAA({
      consent: true,
      cacheDir,
      known: [],
      now,
      fetcher: async () => new Response(JSON.stringify(valid)),
    });
    const file = path.join(cacheDir, 'aa-cache.json');
    const before = await readFile(file, 'utf8');
    await expect(
      refreshAA({
        consent: true,
        cacheDir,
        known: [],
        now: now + 2 * 24 * 60 * 60 * 1000,
        fetcher: async () =>
          new Response('', {
            headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
          }),
      }),
    ).rejects.toThrow(/size limit/);
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});
