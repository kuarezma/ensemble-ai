import {
  EngineInputSchema,
  roles,
  type Assignment,
  type EngineInput,
  type Metrics,
  type Plan,
  type Role,
} from '../schemas.js';
import {
  allowed,
  candidatesFor,
  economicalWorkers,
  operatingTiers,
  meetsBar,
  score,
  roleReasons,
  profileReasons,
  type Candidate,
} from './policy.js';
export {
  allowed,
  candidatesFor,
  effortOrder,
  justifiedEffort,
  MINIMUM_INTELLIGENCE,
  MARGINAL_GAIN_THRESHOLD,
} from './policy.js';
export const rules = [
  {
    id: 'independent-review',
    text: 'The same family never reviews itself. Architect decisions must be audited by another family when available. Replan the reviewer before switching builder fallbacks; the reviewer must differ from the new builder family.',
  },
  {
    id: 'worker-gate',
    text: 'Worker tasks require an automated gate; never assign UI layout/CSS, interactive debugging, or ungated work.',
  },
  {
    id: 'attempt-cap',
    text: 'After at most 2 failed gated attempts, escalate effort then model. Retry only with a changed hypothesis.',
  },
  {
    id: 'handoff',
    text: 'Handoff: original goal, summary, diff, executed gate output, exact file and revision references. Update the HANDOFF/NEXT line.',
  },
  {
    id: 'evidence',
    text: 'Reviews are read-only. Verification counts only when executed; attach test/lint/build output.',
  },
];
export function generatePlan(rawInput: EngineInput): Plan {
  const input = EngineInputSchema.parse(rawInput);
  const accessible = [...input.accessible].sort((a, b) =>
    `${a.id}:${a.via}`.localeCompare(`${b.id}:${b.via}`, 'en'),
  );
  if (new Set(accessible.map((m) => `${m.id}:${m.via}`)).size !== accessible.length)
    throw new Error('Duplicate model/pool access');
  const candidates: Candidate[] = accessible.flatMap(candidatesFor);
  const warnings: string[] = [];
  if (accessible.some((m) => m.family === 'unclassified'))
    warnings.push(
      'Some model families are unverified; independent-family review cannot be assured until classified.',
    );
  const assignments = {} as Plan['assignments'];
  const fallbacks = {} as Plan['fallbacks'];
  const family = (a: Assignment) =>
    accessible.find((m) => m.id === a.model && m.via === a.via)!.family;
  function ranked(role: Role, excludedFamily?: string) {
    let pool = candidates.filter((c) => allowed(c, role) && c.model.family !== excludedFamily);
    if (!pool.length && excludedFamily) return [];
    if (!pool.length) throw new Error(`${role}: no eligible gated candidate`);
    if (role === 'worker') pool = economicalWorkers(pool);
    // Coordination stays at medium even when a lower tier has faster responses.
    if (role === 'orchestrator' && input.profile !== 'saver')
      pool = operatingTiers(pool, role, input.profile);
    const passing = pool.filter((c) => meetsBar(c, role, input.profile));
    if (!passing.length)
      warnings.push(
        `${role}: no candidate meets the minimum intelligence and role requirements; best available selected.`,
      );
    let eligible = operatingTiers(passing.length ? passing : pool, role, input.profile);
    if (role === 'automator' && eligible.some((c) => c.model.scarcity === 1))
      eligible = eligible.filter((c) => c.model.scarcity === 1);
    return eligible.sort(
      (a, b) =>
        score(b, role, input.profile) - score(a, role, input.profile) ||
        `${a.model.id}:${a.model.via}:${a.effort}`.localeCompare(
          `${b.model.id}:${b.model.via}:${b.effort}`,
          'en',
        ),
    );
  }
  function assignment(c: Candidate, role: Role): Assignment {
    const missing = Object.keys(c.metrics).filter((k) => c.metrics[k as keyof Metrics] === null);
    return {
      model: c.model.id,
      effort: c.effort,
      via: c.model.via,
      why: [
        `${input.profile}: ${role} selected for its role requirements.`,
        roleReasons[role],
        profileReasons[input.profile],
        ...(c.benchmarkEffort
          ? [
              `Effort ${c.effort} has gated operational evidence only; ${c.benchmarkEffort} benchmarks are a model-level proxy, not measurements of ${c.effort}.`,
            ]
          : Object.values(c.metrics).every((value) => value === null)
            ? [
                'Missing measurements: no benchmarks are available for this effort; verify operational evidence before use.',
              ]
            : [`Effort ${c.effort} uses its published catalog measurements.`]),
        ...(missing.length ? [`Missing measurements: ${missing.join(', ')}.`] : []),
      ],
    };
  }
  for (const role of roles) {
    const lock = input.locks?.[role];
    const override = role === 'orchestrator' ? input.orchestratorOverride : undefined;
    if (
      lock &&
      override &&
      (lock.model !== override.model ||
        (override.effort && lock.effort !== override.effort) ||
        (override.via && lock.via !== override.via))
    )
      throw new Error('Orchestrator lock conflicts with override');
    const ref = lock ?? override;
    const ranking = ranked(role);
    let candidate = ref
      ? ranking.find(
          (c) =>
            c.model.id === ref.model &&
            (!ref.via || c.model.via === ref.via) &&
            (!ref.effort || c.effort === ref.effort),
        )
      : ranking[0];
    // Locks may bypass the minimum bar, never real efforts or eligibility.
    if (ref && !candidate)
      candidate = candidates.find(
        (c) =>
          c.model.id === ref.model &&
          (!ref.via || c.model.via === ref.via) &&
          (!ref.effort || c.effort === ref.effort) &&
          allowed(c, role),
      );
    if (!candidate) throw new Error(`Invalid or inaccessible assignment for ${role}`);
    assignments[role] = assignment(candidate, role);
    if (ref) {
      assignments[role].why.push('User selection preserved.');
      if (!meetsBar(candidate, role, input.profile))
        warnings.push(
          `${role}: user selection does not meet the minimum role requirements; verify with a gate before use.`,
        );
    }
  }
  // A locked reviewer constrains an unlocked builder, and vice versa.
  if (family(assignments.builder) === family(assignments.reviewer)) {
    const role = input.locks?.reviewer && !input.locks?.builder ? 'builder' : 'reviewer';
    const other = role === 'builder' ? 'reviewer' : 'builder';
    const alternative = ranked(role, family(assignments[other]))[0];
    if (alternative && !input.locks?.[role]) assignments[role] = assignment(alternative, role);
    else if (alternative)
      throw new Error('Locked builder and reviewer must use different families');
    else warnings.push('Only one eligible family: independent builder review is unavailable.');
  }
  for (const role of roles) {
    const seen = new Set([`${assignments[role].model}:${assignments[role].via}`]);
    fallbacks[role] = ranked(role, role === 'reviewer' ? family(assignments.builder) : undefined)
      .filter((c) => {
        const key = `${c.model.id}:${c.model.via}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((c) => {
        const alternative = assignment(c, role);
        if (role === 'builder' && c.model.family === family(assignments.reviewer))
          alternative.why.push(
            'Replan the reviewer from a different family before using this builder fallback.',
          );
        return alternative;
      });
    const chosen = candidates.find(
      (c) =>
        c.model.id === assignments[role].model &&
        c.model.via === assignments[role].via &&
        c.effort === assignments[role].effort,
    )!;
    if (['xhigh', 'max'].includes(chosen.effort) && chosen.model.efforts.length === 1)
      warnings.push(`${role}: only ${chosen.effort} is measured; marginal effort gain is unknown.`);
  }
  const audit = ranked('reviewer', family(assignments.architect))[0];
  if (audit)
    assignments.architect.why.push(
      `Decision audit required from family ${audit.model.family}: ${audit.model.id} ${audit.effort} via ${audit.model.via} before acceptance.`,
    );
  else warnings.push('Only one eligible family: independent architect audit is unavailable.');
  for (const role of ['worker', 'automator'] as const) {
    if (!candidates.some((c) => allowed(c, role) && c.model.scarcity === 1))
      warnings.push(
        `${role}: no abundant pool is available; using the cheapest qualifying accessible option. This uses limited subscription quota.`,
      );
  }
  for (const role of roles) {
    const chosen = candidates.find(
      (c) =>
        c.model.id === assignments[role].model &&
        c.model.via === assignments[role].via &&
        c.effort === assignments[role].effort,
    )!;
    if (chosen.benchmarkEffort)
      warnings.push(
        `${role}: ${chosen.model.name} ${chosen.effort} has operational evidence only; its benchmark measurements are unavailable. Compare the ${chosen.benchmarkEffort} model-level proxy with caution.`,
      );
  }
  return {
    assignments,
    fallbacks,
    rules: rules.map((rule) => ({ ...rule })),
    warnings: [...new Set(warnings)],
  };
}
