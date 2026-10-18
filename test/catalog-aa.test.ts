import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { models, subscriptions, tools, teamTemplate } from '../src/core/catalog.js';
import { ModelSchema, SubscriptionSchema, ToolSchema } from '../src/core/schemas.js';
import { mergeAARecords, normalizeAA, parseAAPayload } from '../src/core/aa/index.js';
import { renderRules } from '../src/core/rules.js';
import { plan } from './helpers.js';
const fixture = readFileSync(new URL('fixtures/aa-payload.txt', import.meta.url), 'utf8');
describe('catalog', () => {
  it('validates every model, plan and tool, all templates and verified flags', () => {
    expect(z.array(ModelSchema).parse(models)).toHaveLength(11);
    expect(z.array(ToolSchema).parse(tools)).toHaveLength(26);
    expect(z.array(SubscriptionSchema).parse(subscriptions)).toHaveLength(11);
    expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
    for (const tool of tools) {
      expect(typeof tool.verified).toBe('boolean');
      expect(tool.template).toBe('team.md');
      expect(teamTemplate).toContain('{{team}}');
      expect(renderRules(plan(), tool)).not.toContain('{{');
      expect(renderRules(plan(), tool, [tool.id, 'codex-cli'])).not.toContain(`- ${tool.name}:`);
      if (!tool.verified) expect(tool.globalPath).toBeNull();
    }
    for (const p of subscriptions)
      for (const ref of p.models)
        for (const effort of ref.efforts)
          expect(
            models.find((m) => m.id === ref.model)?.efforts.some((e) => e.effort === effort),
          ).toBe(true);
  });
  it('keeps all measured efforts and exact source numbers including non-reasoning', () => {
    expect(models.reduce((n, m) => n + m.efforts.length, 0)).toBe(36);
    expect(
      models.find((m) => m.id === 'gpt-6-1-sol')!.efforts.find((e) => e.effort === 'medium')!
        .metrics.intelligence,
    ).toBe(47.7833271274065);
    expect(
      models.find((m) => m.id === 'deepseek-v4-1-flash')!.efforts.map((e) => e.effort),
    ).toEqual(['none', 'max']);
    expect(models.find((m) => m.id === 'gemini-4-argon')!.efforts.map((e) => e.effort)).toEqual([
      'medium',
      'high',
    ]);
    expect(models.find((m) => m.id === 'gemini-4-argon')!.efforts[0]!.metrics).toEqual(
      Object.fromEntries(Object.keys(models[0]!.efforts[0]!.metrics).map((k) => [k, null])),
    );
  });
  it('has no personal data, absolute home paths or source-machine references in catalog/fixtures', () => {
    expect(JSON.stringify({ models, tools, subscriptions, fixture })).not.toMatch(
      /\/Users\/|ugurmac|OKUL|model_görevleri|artificialanalysis-veri/,
    );
  });
});
describe('offline Artificial Analysis parser', () => {
  it('decodes real trimmed RSC model objects with exact measured intelligence', () => {
    const rows = parseAAPayload(fixture);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => typeof r.intelligenceIndex === 'number')).toBe(true);
    const x = normalizeAA(rows[0]!, '2026-10-08');
    expect(x.efforts[0]!.metrics.intelligence).toBe(rows[0]!.intelligenceIndex);
  });
  it('decodes HTML-escaped Next.js payload string wrappers', () => {
    const html = '<script>self.__next_f.push([1,' + JSON.stringify(fixture) + '])</script>';
    expect(parseAAPayload(html)).toEqual(parseAAPayload(fixture));
  });
  it('handles escaped quotes, braces inside names and duplicate records', () => {
    const row = { ...parseAAPayload(fixture)[0]!, name: 'A "quoted" { name }' };
    expect(parseAAPayload(JSON.stringify(row) + '\n' + JSON.stringify(row))).toHaveLength(1);
  });
  it('rejects malformed/truncated payloads and unknown effort rather than guessing', () => {
    expect(() => parseAAPayload('not a model')).toThrow(/No recognized/);
    expect(() => parseAAPayload(fixture.slice(0, 60))).toThrow();
    const row = {
      ...parseAAPayload(fixture)[0]!,
      slug: 'new-model',
      name: 'Unlabelled reasoning model',
      effort: null,
      isReasoning: true,
    };
    expect(() => normalizeAA(row, '2026-10-08')).toThrow(/Effort not declared/);
  });
  it('new models are provisional and require access confirmation and approval', () => {
    const result = mergeAARecords(parseAAPayload(fixture), [], '2026-10-08');
    expect(
      result.models.every(
        (m) => m.provisional && !m.availability.length && !m.gateableTaskTypes.length,
      ),
    ).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.changes[0]!.kind).toBe('new-model');
  });
  it('metric diff is stable, does not overwrite user access, and never mutates catalog', () => {
    const rows = parseAAPayload(fixture),
      first = mergeAARecords(rows, [], '2026-10-08');
    const known = first.models.map((m) => ({
      ...m,
      availability: ['explicit-user-tool'],
      provisional: false,
    }));
    const copy = structuredClone(known);
    expect(mergeAARecords(rows, known, '2026-10-08').changes).toHaveLength(0);
    const changed = { ...rows[0]!, intelligenceIndex: 1 };
    const result = mergeAARecords([changed], known, '2026-10-08');
    expect(result.changes[0]!.kind).toBe('metrics-changed');
    expect(result.models[0]!.availability).toEqual(['explicit-user-tool']);
    expect(known).toEqual(copy);
  });
});
