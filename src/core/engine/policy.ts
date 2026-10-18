import type { AccessibleModel, Effort, EngineInput, Metrics, Role } from '../schemas.js';

export type Candidate = {
  model: AccessibleModel;
  effort: Effort;
  metrics: Metrics;
  benchmarkEffort?: Effort;
};
export const effortOrder: Effort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
export const MINIMUM_INTELLIGENCE: Record<Role, number> = {
  orchestrator: 40,
  architect: 50,
  builder: 35,
  reviewer: 35,
  automator: 30,
  worker: 20,
};
export const MARGINAL_GAIN_THRESHOLD = 5;
export function justifiedEffort(model: AccessibleModel, effort: Effort): boolean {
  if (!['xhigh', 'max'].includes(effort)) return true;
  const ordered = [...model.efforts].sort(
    (a, b) => effortOrder.indexOf(a.effort) - effortOrder.indexOf(b.effort),
  );
  const index = ordered.findIndex((e) => e.effort === effort);
  const current = ordered[index],
    previous = ordered[index - 1];
  if (!current) return false;
  // Native tiers with no comparable cost evidence remain usable, with a warning.
  if (!previous || previous.metrics.cost === null) return true;
  if (
    current.metrics.intelligence === null ||
    previous.metrics.intelligence === null ||
    current.metrics.cost === null ||
    previous.metrics.cost <= 0
  )
    return false;
  const gain = current.metrics.intelligence - previous.metrics.intelligence;
  const ratio = current.metrics.cost / previous.metrics.cost;
  return gain > 0 && (ratio <= 1 || gain / Math.log2(ratio) >= MARGINAL_GAIN_THRESHOLD);
}

export function candidate(
  model: AccessibleModel,
  effort: AccessibleModel['efforts'][number],
): Candidate {
  // Argon medium has local gated evidence, not AA benchmark scores. Keep its
  // catalog measurements null; explicitly disclose the high-tier ranking proxy.
  const reference =
    model.id === 'gemini-4-argon' &&
    effort.effort === 'medium' &&
    Object.values(effort.metrics).every((m) => m === null)
      ? model.efforts.find((e) => e.effort === 'high')
      : undefined;
  return {
    model,
    effort: effort.effort,
    metrics: reference?.metrics ?? effort.metrics,
    ...(reference ? { benchmarkEffort: reference.effort } : {}),
  };
}

export function allowed(c: Candidate, role: Role): boolean {
  if (c.model.id === 'claude-haiku-5-5' && effortOrder.indexOf(c.effort) > 2) return false;
  if (c.model.id === 'gpt-6-1-sol' && effortOrder.indexOf(c.effort) > 3) return false;
  if (role === 'worker')
    return c.model.gateableTaskTypes.length > 0 && effortOrder.indexOf(c.effort) <= 3;
  if (role === 'builder' && !c.model.gateableTaskTypes.includes('spec-with-tests')) return false;
  // Routine operating tiers stop at high. Native max/xhigh models are still
  // useful in specialist roles; their effort labels are not comparable to Sol.
  if (
    effortOrder.indexOf(c.effort) > 3 &&
    c.model.efforts.some((e) => ['medium', 'high'].includes(e.effort))
  )
    return false;
  return justifiedEffort(c.model, c.effort);
}

export function meetsBar(c: Candidate, role: Role, profile: EngineInput['profile']): boolean {
  const m = c.metrics;
  const bar =
    role === 'architect' && profile === 'saver'
      ? 45
      : role === 'worker' && profile !== 'saver'
        ? 40
        : MINIMUM_INTELLIGENCE[role];
  if ((m.intelligence ?? 0) < bar) return false;
  switch (role) {
    // Intelligence + tool reliability are proxies, not an invented IFBench score.
    case 'orchestrator':
      return (m.automationBench ?? 0) >= 0.5;
    case 'architect':
      return (m.knowledgeAccuracy ?? 0) >= 0.6;
    case 'builder':
      return (m.terminalBench ?? 0) >= (profile === 'saver' ? 0.28 : 0.29);
    case 'reviewer':
      return (m.knowledgeAccuracy ?? 0) >= 0.4 && (m.hallucinationRate ?? 1) <= 0.7;
    case 'automator':
      return (m.automationBench ?? 0) >= 0.6;
    case 'worker':
      return true;
  }
}

export function operatingTiers(
  pool: Candidate[],
  role: Role,
  profile: EngineInput['profile'],
): Candidate[] {
  // Collapse efforts per model/pool before comparing models. A stronger effort
  // cannot win a routine role merely by adding benchmark points.
  return pool.filter((c) => {
    const peers = pool.filter((p) => p.model.id === c.model.id && p.model.via === c.model.via);
    const target =
      role === 'orchestrator'
        ? 2
        : profile === 'quality' && ['architect', 'builder', 'reviewer'].includes(role)
          ? 3
          : role === 'worker' || role === 'automator' || profile === 'saver'
            ? 0
            : 2;
    const atTarget = peers.filter((p) => effortOrder.indexOf(p.effort) >= target);
    const available = atTarget.length ? atTarget : peers;
    const lowest = Math.min(...available.map((p) => effortOrder.indexOf(p.effort)));
    return effortOrder.indexOf(c.effort) === lowest;
  });
}

export function score(c: Candidate, role: Role, profile: EngineInput['profile']): number {
  const m = c.metrics;
  const intelligence = (m.intelligence ?? 0) / 100;
  const cost = m.cost ?? 10000;
  const tokens = (m.outputTokensPerTask ?? 200000) / 100000;
  const scarcity = c.model.scarcity;
  const price = c.model.price;
  const tokenPrice = (price.input ?? 20) + 3 * (price.output ?? 100);
  const cachePrice = price.cacheRead ?? 10;
  switch (role) {
    case 'orchestrator':
      return (
        (4 * Math.min(m.speed ?? 0, 250)) / 250 -
        (2 * Math.min(m.ttft ?? 300, 300)) / 300 -
        cost / 5000 -
        tokens / 2 -
        cachePrice / 5 -
        (scarcity - 1) / 10
      );
    case 'architect':
      return (
        4 * intelligence +
        4 * (m.knowledgeAccuracy ?? 0) -
        (profile === 'quality' ? 0 : cost / 1000 + (scarcity - 1) / 2)
      );
    case 'builder':
      return profile === 'quality'
        ? 4 * (m.terminalBench ?? 0) + intelligence + (m.knowledgeAccuracy ?? 0) - cost / 20000
        : (100 * (m.terminalBench ?? 0)) /
            Math.sqrt(Math.max(cost, 1) * scarcity * (profile === 'saver' ? tokenPrice : 1));
    case 'reviewer':
      return (
        2 * intelligence +
        4 * (m.knowledgeAccuracy ?? 0) -
        4 * (m.hallucinationRate ?? 1) -
        cost / 20000
      );
    case 'automator':
      return 5 * (m.automationBench ?? 0) - cost / 20000;
    case 'worker':
      return -tokenPrice - cachePrice - cost / 10000 - tokens;
  }
}

export function candidatesFor(model: AccessibleModel): Candidate[] {
  return [...model.efforts]
    .sort((a, b) => effortOrder.indexOf(a.effort) - effortOrder.indexOf(b.effort))
    .map((effort) => candidate(model, effort));
}
export function economicalWorkers(pool: Candidate[]) {
  const abundant = pool.filter((c) => c.model.scarcity === 1);
  const eligible = abundant.length ? abundant : pool;
  const price = (c: Candidate) =>
    (c.model.price.input ?? Infinity) + (c.model.price.output ?? Infinity);
  const cheapest = Math.min(...eligible.map(price));
  return eligible.filter((c) => price(c) === cheapest);
}
export const roleReasons: Record<Role, string> = {
  orchestrator:
    'Coordinates instructions quickly at the lowest qualifying cost; cache price and response efficiency matter.',
  architect:
    'Balances knowledge accuracy and intelligence; a different family must audit the decision.',
  builder: 'Uses measured TerminalBench performance per scarce quota, with automated gates.',
  reviewer: 'Balances low hallucination with knowledge accuracy; reviews a different family.',
  automator: 'Uses AutomationBench to choose reliable tool automation from abundant pools.',
  worker:
    'Keeps gated routine work on the cheapest available abundant pool, without very high effort.',
};
export const profileReasons: Record<EngineInput['profile'], string> = {
  saver: 'Saver uses the lowest effort that passes each role bar and protects scarce quota.',
  balanced:
    'Balanced uses normal operating efforts and saves scarce Claude quota for difficult decisions.',
  quality:
    'Quality prioritizes knowledge and intelligence for architecture and stronger coding, with independent audit.',
};
