import type { TextKey } from './App.js';
/** Core diagnostics are structured text; keep UI copy in the selected language. */
export function explain(text: string, t: (key: TextKey) => string) {
  const fit =
    /^(saver|balanced|quality): (orchestrator|architect|builder|reviewer|automator|worker) (?:selected for its role requirements\.|fit; intelligence )/.exec(
      text,
    );
  if (fit)
    return t('reasonFit')
      .replace('{profile}', t(fit[1] as TextKey))
      .replace('{role}', t(fit[2] as TextKey));
  const proxy =
    /^Effort (none|low|medium|high|xhigh|max) has gated operational evidence only; (none|low|medium|high|xhigh|max) benchmarks/.exec(
      text,
    );
  if (proxy)
    return t('reasonProxy')
      .replace('{effort}', t(proxy[1] as TextKey))
      .replace('{reference}', t(proxy[2] as TextKey));
  const effort =
    /^Effort (none|low|medium|high|xhigh|max) (?:uses its published|is measured;)/.exec(text);
  if (effort) return t('reasonEffort').replace('{effort}', t(effort[1] as TextKey));
  const reasons: [string, TextKey][] = [
    ['Coordinates instructions', 'reasonOrchestrator'],
    ['Balances knowledge accuracy', 'reasonArchitect'],
    ['Uses measured TerminalBench', 'reasonBuilder'],
    ['Balances low hallucination', 'reasonReviewer'],
    ['Uses AutomationBench', 'reasonAutomator'],
    ['Keeps gated routine work', 'reasonWorker'],
    ['Saver uses', 'reasonSaver'],
    ['Balanced uses', 'reasonBalanced'],
    ['Quality prioritizes', 'reasonQuality'],
    ['Replan the reviewer', 'reasonReplan'],
  ];
  for (const [prefix, key] of reasons) if (text.startsWith(prefix)) return t(key);
  if (text.startsWith('Missing measurements:')) return t('reasonMissing');
  if (
    text === 'User selection preserved.' ||
    text === 'Manual' ||
    text === 'Locked' ||
    text === t('manual')
  )
    return t('reasonUser');
  const audit =
    /^Decision audit required from family \S+: (\S+) (none|low|medium|high|xhigh|max) via /.exec(
      text,
    );
  if (audit) return `${t('reasonAudit')} ${audit[1]} (${t(audit[2] as TextKey)}).`;
  if (text.startsWith('Decision audit required')) return t('reasonAudit');
  if (text.startsWith('Only one eligible family:')) return t('warningFamilies');
  if (text.startsWith('Some model families are unverified')) return t('warningUnclassified');
  if (text.includes('no candidate meets the minimum')) return t('warningMinimum');
  if (text.includes('user selection does not meet the minimum')) return t('warningMinimum');
  if (text.includes('marginal effort gain is unknown')) return t('warningEffort');
  if (text.includes('no abundant pool is available')) return t('warningAbundance');
  if (text.includes('operational evidence only')) return t('warningProxy');
  return t('reasonGeneric');
}
