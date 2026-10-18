import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { absoluteRoot, assertSafePath } from '../apply/paths.js';
import { type Model } from '../schemas.js';
import { mergeAARecords, parseAAPayload, RawSchema } from './index.js';
const CacheSchema = z.object({
  fetchedAt: z.number().finite().nonnegative(),
  records: z.array(RawSchema),
  warnings: z.array(z.string()).default([]),
});
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
/** Bound decoded response bytes too: Content-Length may be absent or compressed. */
export async function readBoundedResponseText(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Response exceeds size limit (${maxBytes} bytes)`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Response exceeds size limit (${maxBytes} bytes)`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
export type RefreshOptions = {
  consent: boolean;
  cacheDir: string;
  known: Model[];
  now?: number;
  fetcher?: typeof fetch;
};
/** Explicit consent is required; no network, cache or HOME work happens on module import. */
export async function refreshAA(options: RefreshOptions) {
  if (!options.consent)
    return {
      status: 'disabled' as const,
      models: options.known,
      changes: [],
      requiresApproval: false,
      warnings: [],
    };
  const root = absoluteRoot(options.cacheDir),
    file = path.join(root, 'aa-cache.json'),
    now = options.now ?? Date.now();
  await assertSafePath(root, file);
  try {
    const cache = CacheSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    if (now >= cache.fetchedAt && now - cache.fetchedAt < REFRESH_INTERVAL_MS) {
      const result = mergeAARecords(
        cache.records,
        options.known,
        new Date(cache.fetchedAt).toISOString().slice(0, 10),
      );
      return {
        status: 'cached' as const,
        ...result,
        warnings: [...cache.warnings, ...result.warnings],
      };
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
      !(error instanceof SyntaxError) &&
      !(error instanceof z.ZodError)
    )
      throw error;
  }
  const response = await (options.fetcher ?? fetch)('https://artificialanalysis.ai/models', {
    headers: {
      'User-Agent':
        'Ensemble/0.1 (optional model catalog refresh; Artificial Analysis attribution)',
    },
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Artificial Analysis returned HTTP ${response.status}`);
  const warnings: string[] = [];
  const records = parseAAPayload(await readBoundedResponseText(response), warnings);
  const result = mergeAARecords(records, options.known, new Date(now).toISOString().slice(0, 10));
  const temp = path.join(root, `.aa-cache-${randomUUID()}.tmp`);
  await mkdir(root, { recursive: true });
  await assertSafePath(root, file);
  try {
    await writeFile(temp, JSON.stringify({ fetchedAt: now, records, warnings }), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await assertSafePath(root, file);
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
  return { status: 'refreshed' as const, ...result, warnings: [...warnings, ...result.warnings] };
}
