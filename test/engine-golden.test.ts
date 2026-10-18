import { describe, expect, it } from 'vitest';
import { models, subscriptions } from '../src/core/catalog.js';
import { generatePlan } from '../src/core/engine/index.js';
import { PlanSchema, roles, type EngineInput, type Plan } from '../src/core/schemas.js';

function fromPlans(...ids: string[]): EngineInput {
  return {
    profile: 'balanced',
    tools: [],
    accessible: ids.flatMap((id) => {
      const subscription = subscriptions.find((s) => s.id === id)!;
      return subscription.models.map((ref) => {
        const model = structuredClone(models.find((m) => m.id === ref.model)!);
        return {
          ...model,
          efforts: model.efforts.filter((e) => ref.efforts.includes(e.effort)),
          via: subscription.via,
          scarcity: subscription.scarcity,
        };
      });
    }),
  };
}
const full = () => fromPlans('anthropic-pro', 'openai-plus', 'google-google-ai-pro');
const pair = () => fromPlans('anthropic-pro', 'openai-plus');
const family = (id: string) => models.find((m) => m.id === id)!.family;
const selections = (plan: Plan) =>
  Object.fromEntries(
    roles.map((role) => [role, [plan.assignments[role].model, plan.assignments[role].effort]]),
  );

function verify(input: EngineInput): Plan {
  const copy = structuredClone(input);
  const plan = generatePlan(input);
  expect(PlanSchema.safeParse(plan).success).toBe(true);
  expect(input).toEqual(copy);
  expect(generatePlan(input)).toEqual(plan);
  expect(
    generatePlan({
      ...input,
      accessible: [...input.accessible]
        .reverse()
        .map((m) => ({ ...m, efforts: [...m.efforts].reverse() })),
    }),
  ).toEqual(plan);
  for (const role of roles) {
    for (const a of [plan.assignments[role], ...plan.fallbacks[role]]) {
      const model = input.accessible.find((m) => m.id === a.model && m.via === a.via)!;
      expect(model.efforts.some((e) => e.effort === a.effort)).toBe(true);
      expect(a.why.join(' ')).not.toMatch(/scarcity \d\/3|capacity limits|normalized/);
      if (role === 'worker') {
        expect(['xhigh', 'max']).not.toContain(a.effort);
        expect(model.gateableTaskTypes.length).toBeGreaterThan(0);
      }
    }
  }
  if (new Set(input.accessible.map((m) => m.family)).size > 1) {
    expect(family(plan.assignments.builder.model)).not.toBe(
      family(plan.assignments.reviewer.model),
    );
    const audit = plan.assignments.architect.why.find((s) => s.startsWith('Decision audit'))!;
    expect(audit).toBeTruthy();
    expect(audit).not.toContain(`from family ${family(plan.assignments.architect.model)}:`);
  } else {
    expect(plan.warnings.join(' ')).toMatch(/independent builder review/);
    expect(plan.warnings.join(' ')).toMatch(/independent architect audit/);
  }
  return plan;
}

describe('Phase C golden plans', () => {
  it.each(['anthropic-pro', 'anthropic-max'])(
    'G1: %s + Codex + Gemini conserves premium quota',
    (claude) => {
      const p = verify(fromPlans(claude, 'openai-plus', 'google-google-ai-pro'));
      expect(selections(p)).toEqual({
        orchestrator: ['claude-sonnet-5-5', 'medium'],
        architect: ['gpt-6-1-sol', 'high'],
        builder: ['gpt-6-1-sol', 'medium'],
        reviewer: ['gemini-4-argon', 'medium'],
        automator: ['gemini-4-argon', 'medium'],
        worker: ['gemini-3-8-flash', 'high'],
      });
      expect(p.assignments.architect.why.join(' ')).toContain('gemini-4-argon medium');
      expect(p.fallbacks.builder.slice(0, 2).map((a) => [a.model, a.effort])).toEqual([
        ['gemini-4-argon', 'medium'],
        ['claude-opus-5-5', 'medium'],
      ]);
      expect(p.fallbacks.builder[0]!.why.join(' ')).toContain('Replan the reviewer');
      expect(p.warnings.join(' ')).toContain('operational evidence only');
    },
  );

  it('G2: Claude + Codex uses Claude review and cheap qualified quota fallbacks', () => {
    const p = verify(pair());
    expect(selections(p)).toEqual({
      orchestrator: ['claude-sonnet-5-5', 'medium'],
      architect: ['gpt-6-1-sol', 'high'],
      builder: ['gpt-6-1-sol', 'medium'],
      reviewer: ['claude-opus-5-5', 'medium'],
      automator: ['gpt-6-1-sol', 'medium'],
      worker: ['claude-haiku-5-5', 'low'],
    });
    expect(p.assignments.architect.why.join(' ')).toContain('claude-opus-5-5 medium');
    expect(p.warnings).toContainEqual(expect.stringMatching(/automator: no abundant pool/));
    expect(p.warnings).toContainEqual(expect.stringMatching(/worker: no abundant pool/));
  });

  it.each(['saver', 'balanced', 'quality'] as const)(
    'G3: Claude only, %s, stays usable and caps Haiku',
    (profile) => {
      const input = { ...fromPlans('anthropic-pro'), profile };
      const p = verify(input);
      expect([p.assignments.orchestrator.model, p.assignments.orchestrator.effort]).toEqual([
        'claude-sonnet-5-5',
        'medium',
      ]);
      expect(p.assignments.architect.model).toBe('claude-opus-5-5');
      expect(['medium', 'high']).toContain(p.assignments.architect.effort);
      expect(p.assignments.worker.model).toBe('claude-haiku-5-5');
      expect(['low', 'medium']).toContain(p.assignments.worker.effort);
      expect(p.assignments.builder.model).toBe(
        profile === 'saver' ? 'claude-sonnet-5-5' : 'claude-opus-5-5',
      );
      if (p.assignments.builder.model === 'claude-sonnet-5-5')
        expect(p.assignments.reviewer.model).toBe('claude-opus-5-5');
    },
  );

  it('G4: Gemini only uses Argon for gated coding and Flash for routine work', () => {
    const p = verify(fromPlans('google-google-ai-pro'));
    expect(p.assignments.builder.model).toBe('gemini-4-argon');
    expect(p.assignments.automator.effort).toBe('medium');
    expect([p.assignments.worker.model, p.assignments.worker.effort]).toEqual([
      'gemini-3-8-flash',
      'high',
    ]);
  });

  it('G5: Codex only uses normal efforts and warns about independent review', () => {
    const p = verify(fromPlans('openai-plus'));
    expect(p.assignments.architect.effort).toBe('high');
    expect(p.assignments.builder.effort).toBe('medium');
    expect(p.assignments.worker.effort).toBe('low');
    expect(Object.values(p.assignments).every((a) => a.model === 'gpt-6-1-sol')).toBe(true);
  });

  it('G6: open models remain usable without Claude or GPT', () => {
    const input: EngineInput = {
      profile: 'balanced',
      tools: ['opencode'],
      accessible: models
        .filter((m) => ['glm', 'deepseek', 'kimi', 'muse'].includes(m.family))
        .map((m) => ({ ...structuredClone(m), via: 'opencode', scarcity: 1 })),
    };
    const p = verify(input);
    expect(p.assignments.builder.model).toBe('glm-5-3');
    expect(p.assignments.automator.model).toBe('deepseek-v4-1-flash');
    expect(p.assignments.worker.effort).toBe('none');
    expect(p.warnings.join(' ')).toMatch(/architect: no candidate meets/);
  });

  it('G7: saver, balanced and quality change actual work and explain the tradeoff', () => {
    const plans = (['saver', 'balanced', 'quality'] as const).map((profile) =>
      verify({ ...full(), profile }),
    );
    expect(new Set(plans.map((p) => JSON.stringify(selections(p)))).size).toBe(3);
    expect(plans[0]!.assignments.worker.effort).toBe('low');
    expect(plans[0]!.assignments.architect.effort).toBe('medium');
    expect(plans[0]!.assignments.worker.why.join(' ')).toContain('lowest effort');
    expect(plans[1]!.assignments.builder.why.join(' ')).toContain('saves scarce Claude quota');
    expect([plans[2]!.assignments.architect.model, plans[2]!.assignments.architect.effort]).toEqual(
      ['claude-opus-5-5', 'high'],
    );
    expect(plans[2]!.assignments.architect.why.join(' ')).toContain('prioritizes knowledge');
    for (const p of plans)
      for (const role of ['automator', 'worker'] as const)
        expect(full().accessible.find((m) => m.id === p.assignments[role].model)!.scarcity).toBe(1);
  });

  it('G8: manual orchestrator and builder locks survive while review is replanned', () => {
    const input = full();
    input.orchestratorOverride = { model: 'claude-opus-5-5', effort: 'medium' };
    input.locks = {
      builder: { model: 'gemini-4-argon', effort: 'medium', via: 'gemini-cli', why: ['Manual'] },
    };
    const p = verify(input);
    expect(p.assignments.orchestrator.model).toBe('claude-opus-5-5');
    expect(p.assignments.builder.model).toBe('gemini-4-argon');
    expect(family(p.assignments.reviewer.model)).not.toBe('gemini');
    expect(p.assignments.orchestrator.why).toContain('User selection preserved.');
  });

  it('G8: a locked reviewer replans the builder and incompatible locks are rejected', () => {
    const input = full();
    const locked = {
      model: 'gpt-6-1-sol',
      effort: 'medium' as const,
      via: 'codex-cli',
      why: ['Manual'],
    };
    input.locks = { reviewer: locked };
    const p = verify(input);
    expect(p.assignments.reviewer.model).toBe('gpt-6-1-sol');
    expect(p.assignments.builder.model).toBe('gemini-4-argon');
    input.locks.builder = locked;
    expect(() => generatePlan(input)).toThrow(/different families/);
  });

  it('replans independent review for each builder fallback and preserves pool access', () => {
    const input = full();
    const initial = generatePlan(input);
    for (const fallback of initial.fallbacks.builder) {
      const p = verify({ ...input, locks: { builder: fallback } });
      expect(p.assignments.builder.model).toBe(fallback.model);
      expect(p.assignments.builder.via).toBe(fallback.via);
    }
  });

  it('does not invent benchmark scores when only operational Argon medium is accessible', () => {
    const input = full();
    input.accessible.find((m) => m.id === 'gemini-4-argon')!.efforts = input.accessible
      .find((m) => m.id === 'gemini-4-argon')!
      .efforts.filter((e) => e.effort === 'medium');
    input.locks = {
      automator: { model: 'gemini-4-argon', effort: 'medium', via: 'gemini-cli', why: ['Manual'] },
    };
    const p = verify(input);
    expect(p.assignments.automator.why.join(' ')).toContain('no benchmarks are available');
    expect(p.assignments.automator.why.join(' ')).not.toContain('published catalog measurements');
    expect(p.warnings.join(' ')).toContain('user selection does not meet the minimum');
  });

  it('scores catalog changes rather than hardcoding the golden models', () => {
    const input = full();
    input.accessible
      .filter((m) => m.family === 'gpt')
      .forEach((m) =>
        m.efforts.forEach((e) => {
          e.metrics.terminalBench = 0;
        }),
      );
    expect(verify(input).assignments.builder.model).toBe('gemini-4-argon');
    const changed = full();
    changed.accessible
      .find((m) => m.id === 'gemini-4-argon')!
      .efforts.forEach((e) => {
        if (e.metrics.hallucinationRate !== null) e.metrics.hallucinationRate = 0.99;
      });
    expect(verify(changed).assignments.reviewer.model).not.toBe('gemini-4-argon');
  });
});
