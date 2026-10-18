import { z } from 'zod';
import { ModelSchema, type Model, type Metrics, type Effort } from '../schemas.js';
export const RawSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    shortName: z.string(),
    effort: z.object({ slug: z.string() }).nullish(),
    release: z.object({ slug: z.string(), name: z.string() }).nullish(),
    isReasoning: z.boolean().optional(),
  })
  .passthrough();
export type RawModel = z.infer<typeof RawSchema>;
// A decoder-style boundary scan respects strings, escaped quotes and nested JSON.
function objectAt(text: string, start: number): unknown {
  let depth = 0,
    inString = false,
    escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('Truncated model JSON');
}
export function parseAAPayload(payload: string, warnings: string[] = []): RawModel[] {
  const initialWarnings = warnings.length;
  const inputs = [payload];
  // HTML embeds RSC payloads as JSON strings in self.__next_f.push(...).
  for (const match of payload.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    if (!match[0].includes('\\"slug\\"')) continue;
    try {
      const decoded: unknown = JSON.parse(match[0]);
      if (typeof decoded === 'string') inputs.push(decoded);
    } catch {
      /* Ignore unrelated script strings. */
    }
  }
  const result = new Map<string, RawModel>();
  for (const text of inputs) {
    for (const match of text.matchAll(/\{"slug":"[^"\n]+","name":"(?:[^"\\]|\\.)*","shortName"/g)) {
      try {
        const raw = RawSchema.parse(objectAt(text, match.index));
        if (typeof raw.intelligenceIndex === 'number') result.set(raw.slug, raw);
      } catch {
        warnings.push('Skipped malformed Artificial Analysis model record');
      }
    }
  }
  if (!result.size && warnings.length === initialWarnings)
    throw new Error('No recognized Artificial Analysis model records');
  return [...result.values()].sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
}
function numberAt(raw: RawModel, ...paths: string[]): number | null {
  for (const path of paths) {
    let value: unknown = raw;
    for (const key of path.split('.'))
      value =
        value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}
export function normalizeAA(raw: RawModel, date: string, known: Model[] = []): Model {
  const suffix = ['non-reasoning', 'none', 'low', 'medium', 'high', 'xhigh', 'max'].find((e) =>
    raw.slug.endsWith('-' + e),
  );
  const labelEffort = /\((?:Adaptive Reasoning, )?(low|medium|high|xhigh|max)(?:\b)/i
    .exec(raw.name)?.[1]
    ?.toLowerCase();
  const declared =
    raw.effort?.slug ?? suffix ?? labelEffort ?? (raw.isReasoning === false ? 'none' : null);
  const effort = (declared === 'non-reasoning' ? 'none' : declared) as Effort | null;
  if (!effort) throw new Error(`Effort not declared: ${raw.slug}`);
  const id =
    raw.release?.slug ??
    known.find((m) => m.efforts.some((e) => e.source.endsWith('/' + raw.slug)))?.id ??
    (suffix ? raw.slug.slice(0, -suffix.length - 1) : raw.slug);
  const previous = known.find((m) => m.id === id);
  const metrics: Metrics = {
    intelligence: numberAt(raw, 'intelligenceIndex'),
    terminalBench: numberAt(raw, 'terminalBench40'),
    automationBench: numberAt(raw, 'automationBenchPartialScore'),
    knowledgeAccuracy: numberAt(raw, 'omniscienceAccuracy'),
    hallucinationRate:
      numberAt(raw, 'omniscienceHallucinationRate') ??
      (numberAt(raw, 'omniscienceNonHallucination') === null
        ? null
        : 1 - numberAt(raw, 'omniscienceNonHallucination')!),
    outputTokensPerTask: numberAt(raw, 'intelligenceIndexOutputTokensPerTask.output'),
    cost: numberAt(raw, 'intelligenceIndexCost.total'),
    speed: numberAt(raw, 'medianOutputTokensPerSecond', 'timescaleData.medianOutputSpeed'),
    ttft: numberAt(raw, 'medianTimeToFirstAnswerTokenSeconds', 'timeToFirstAnswerToken.total'),
  };
  return ModelSchema.parse({
    id,
    name: raw.release?.name ?? raw.name,
    family: previous?.family ?? 'unclassified',
    efforts: [
      {
        effort,
        metrics,
        source: 'https://artificialanalysis.ai/models/' + raw.slug,
        date,
        sourceSnapshot: 'optional-refresh',
        dateKind: 'refreshed',
      },
    ],
    context: numberAt(raw, 'contextWindowTokens'),
    price: {
      input: numberAt(raw, 'price1mInputTokens'),
      output: numberAt(raw, 'price1mOutputTokens'),
      cacheRead: numberAt(raw, 'cacheHitPrice'),
    },
    availability: previous?.availability ?? [],
    availabilityEstimate: true,
    gateableTaskTypes: previous?.gateableTaskTypes ?? [],
    provisional: !previous,
  });
}
export function mergeAARecords(records: unknown[], known: Model[], date: string) {
  const next = new Map(known.map((m) => [m.id, structuredClone(m)]));
  const warnings: string[] = [];
  const changes: {
    model: string;
    effort: Effort;
    kind: 'new-model' | 'new-effort' | 'metrics-changed';
    before: Metrics | null;
    after: Metrics;
  }[] = [];
  for (const raw of records) {
    let model: Model;
    try {
      model = normalizeAA(RawSchema.parse(raw), date, known);
    } catch (error) {
      const slug = RawSchema.safeParse(raw);
      warnings.push(
        `Skipped Artificial Analysis record${slug.success ? ` ${slug.data.slug}` : ''}: ${error instanceof Error ? error.message : 'invalid record'}`,
      );
      continue;
    }
    const variant = model.efforts[0]!;
    const existing = next.get(model.id);
    const old = existing?.efforts.find((e) => e.effort === variant.effort);
    if (!old || JSON.stringify(old.metrics) !== JSON.stringify(variant.metrics))
      changes.push({
        model: model.id,
        effort: variant.effort,
        kind: !existing ? 'new-model' : !old ? 'new-effort' : 'metrics-changed',
        before: old?.metrics ?? null,
        after: variant.metrics,
      });
    if (existing)
      existing.efforts = [...existing.efforts.filter((e) => e.effort !== variant.effort), variant];
    else next.set(model.id, model);
  }
  return { models: [...next.values()], changes, requiresApproval: changes.length > 0, warnings };
}
