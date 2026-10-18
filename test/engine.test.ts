import { describe, expect, it } from 'vitest';
import { generatePlan, justifiedEffort } from '../src/core/engine/index.js';
import { PlanSchema, roles } from '../src/core/schemas.js';
import { access, input } from './helpers.js';
const family = (id: string) => access().find((m) => m.id === id)!.family;
describe('engine hard rules', () => {
  it.each(['saver', 'balanced', 'quality'] as const)(
    '%s returns a valid six-role plan with real efforts, reasons and independent review',
    (profile) => {
      const p = generatePlan(input(profile));
      expect(PlanSchema.safeParse(p).success).toBe(true);
      expect(Object.keys(p.assignments)).toHaveLength(6);
      expect(family(p.assignments.builder.model)).not.toBe(family(p.assignments.reviewer.model));
      for (const role of roles) {
        const a = p.assignments[role],
          model = access().find((m) => m.id === a.model)!;
        expect(model.efforts.some((e) => e.effort === a.effort)).toBe(true);
        expect(a.why.join(' ')).not.toBe('');
        if (role === 'worker') expect(model.gateableTaskTypes.length).toBeGreaterThan(0);
        if (['max', 'xhigh'].includes(a.effort) && !(profile === 'quality' && role === 'architect'))
          expect(justifiedEffort(model, a.effort)).toBe(true);
      }
      expect(p.assignments.architect.why.join(' ')).toContain(
        'Decision audit required from family',
      );
    },
  );
  it('is deterministic including input permutations and never mutates inputs', () => {
    const i = input(),
      copy = structuredClone(i),
      p = generatePlan(i);
    expect(generatePlan(i)).toEqual(p);
    expect(i).toEqual(copy);
    expect(generatePlan({ ...i, accessible: [...i.accessible].reverse() })).toEqual(p);
  });
  it('profiles produce different allocation choices', () => {
    const plans = ['saver', 'balanced', 'quality'].map((profile) =>
      JSON.stringify(
        Object.values(generatePlan(input(profile as 'saver')).assignments).map((a) => [
          a.model,
          a.effort,
          a.via,
        ]),
      ),
    );
    expect(new Set(plans).size).toBe(3);
  });
  it('single model remains usable with independence warnings', () => {
    const i = input();
    i.accessible = [i.accessible[3]!];
    const p = generatePlan(i);
    expect(Object.values(p.assignments).every((a) => a.model === i.accessible[0]!.id)).toBe(true);
    expect(p.warnings.join(' ')).toMatch(/independent builder review/);
    expect(p.warnings.join(' ')).toMatch(/architect audit/);
  });
  it('single family with multiple models warns rather than errors', () => {
    const i = input();
    i.accessible = i.accessible.filter((m) => m.family === 'claude');
    expect(generatePlan(i).warnings.join()).toContain('Only one eligible family');
  });
  it('never assigns a worker to ungated capability', () => {
    const i = input();
    i.accessible.forEach((m) => {
      m.gateableTaskTypes = [];
    });
    i.accessible[0]!.gateableTaskTypes = ['spec-with-tests'];
    expect(generatePlan(i).assignments.worker.model).toBe(i.accessible[0]!.id);
  });
  it('rejects an entirely ungated worker pool', () => {
    const i = input();
    i.accessible.forEach((m) => {
      m.gateableTaskTypes = [];
    });
    expect(() => generatePlan(i)).toThrow(/eligible gated/);
  });
  it('preserves a valid orchestrator override and role lock', () => {
    const i = input();
    i.orchestratorOverride = { model: 'claude-sonnet-5-5', effort: 'medium' };
    i.locks = {
      builder: { model: 'gpt-6-1-sol', effort: 'high', via: 'codex-cli', why: ['Locked'] },
    };
    const p = generatePlan(i);
    expect(p.assignments.orchestrator.model).toBe('claude-sonnet-5-5');
    expect(p.assignments.builder.effort).toBe('high');
    expect(family(p.assignments.reviewer.model)).not.toBe('gpt');
  });
  it('replans builder around a locked reviewer', () => {
    const i = input();
    i.locks = {
      reviewer: { model: 'gpt-6-1-sol', effort: 'medium', via: 'codex-cli', why: ['User'] },
    };
    const p = generatePlan(i);
    expect(p.assignments.reviewer.model).toBe('gpt-6-1-sol');
    expect(family(p.assignments.builder.model)).not.toBe('gpt');
  });
  it('rejects incompatible dual locks when an independent family exists', () => {
    const i = input();
    const a = { model: 'gpt-6-1-sol', effort: 'medium' as const, via: 'codex-cli', why: ['User'] };
    i.locks = { builder: a, reviewer: a };
    expect(() => generatePlan(i)).toThrow(/different families/);
  });
  it('rejects unknown efforts and inaccessible overrides', () => {
    const i = input();
    i.orchestratorOverride = { model: 'absent' };
    expect(() => generatePlan(i)).toThrow(/Invalid/);
    i.orchestratorOverride = { model: 'gemini-4-argon', effort: 'low' };
    expect(() => generatePlan(i)).toThrow(/Invalid/);
  });
  it('rejects unjustified max locks and conflicting override', () => {
    const i = input();
    i.locks = { builder: { model: 'gpt-6-1-sol', effort: 'max', via: 'codex-cli', why: ['User'] } };
    expect(() => generatePlan(i)).toThrow(/Invalid/);
    i.locks = {
      orchestrator: { model: 'gpt-6-1-sol', effort: 'medium', via: 'codex-cli', why: ['User'] },
    };
    i.orchestratorOverride = { model: 'claude-opus-5-5' };
    expect(() => generatePlan(i)).toThrow(/conflicts/);
  });
  it('requires marginal gain for very high efforts with comparative data', () => {
    const m = access().find((m) => m.id === 'gpt-6-1-sol')!;
    expect(justifiedEffort(m, 'max')).toBe(false);
    expect(justifiedEffort(m, 'xhigh')).toBe(false);
  });
  it('fallbacks stay eligible and reviewer alternatives stay independent', () => {
    const p = generatePlan(input());
    for (const a of p.fallbacks.reviewer)
      expect(family(a.model)).not.toBe(family(p.assignments.builder.model));
    for (const a of p.fallbacks.worker)
      expect(access().find((m) => m.id === a.model)!.gateableTaskTypes.length).toBeGreaterThan(0);
  });
  it('warns when all metrics are absent instead of inventing measurements', () => {
    const i = input();
    i.accessible = [i.accessible[3]!];
    i.accessible.forEach((m) =>
      m.efforts.forEach((e) =>
        Object.keys(e.metrics).forEach((k) => {
          e.metrics[k as keyof typeof e.metrics] = null;
        }),
      ),
    );
    expect(generatePlan(i).warnings.join()).toContain('minimum intelligence');
  });
  it('uses a weaker independent family when the minimum bar cannot be met independently', () => {
    const i = input();
    i.accessible = i.accessible.filter((m) => ['gpt-6-1-sol', 'claude-haiku-5-5'].includes(m.id));
    i.accessible
      .find((m) => m.family === 'claude')!
      .efforts.forEach((e) => {
        e.metrics.intelligence = 10;
      });
    i.locks = {
      builder: { model: 'gpt-6-1-sol', effort: 'medium', via: 'codex-cli', why: ['User'] },
    };
    const p = generatePlan(i);
    expect(family(p.assignments.reviewer.model)).toBe('claude');
    expect(p.warnings.join()).toContain('reviewer: no candidate meets');
  });
  it('keeps rule objects isolated between returned plans', () => {
    const i = input(),
      p = generatePlan(i),
      expected = structuredClone(p);
    p.rules[0]!.text = 'Changed by consumer';
    p.rules.push({ id: 'custom', text: 'User rule' });
    expect(generatePlan(i)).toEqual(expected);
  });
  it('handles zero-price models deterministically in saver profile without NaN scores', () => {
    const i = input('saver');
    i.accessible.forEach((m) => {
      m.price = { input: 0, output: 0, cacheRead: 0 };
    });
    const first = generatePlan(i);
    const reversed = generatePlan({ ...i, accessible: [...i.accessible].reverse() });
    expect(first).toEqual(reversed);
  });
});
