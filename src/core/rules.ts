import { teamTemplate, tools } from './catalog.js';
import { PlanSchema, roles, type Plan, type Tool } from './schemas.js';
// Keep model names and imported free text on one Markdown line; never emit shell commands from user strings.
function cell(text: string): string {
  return text
    .replace(/[\r\n]/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/<!--/g, '&lt;!--');
}
export function renderRules(rawPlan: Plan, tool: Tool, installedPeers: string[] = []): string {
  const plan = PlanSchema.parse(rawPlan);
  const team = [
    '| Role | Model | Effort | Pool | Why |',
    '| --- | --- | --- | --- | --- |',
    ...roles.map((role) => {
      const a = plan.assignments[role];
      return `| ${role} | ${cell(a.model)} | ${a.effort} | ${cell(a.via)} | ${cell(a.why.join(' '))} |`;
    }),
  ].join('\n');
  const peers = tools.filter((t) => installedPeers.includes(t.id));
  const invocations = peers.length
    ? peers
        .map(
          (t) =>
            `- ${t.name}: ${t.headlessCli ? '`' + t.headlessCli + '` (substitute client-validated IDs; quote the prompt)' : 'manual handoff; no verified headless command'}`,
        )
        .join('\n')
    : 'No installed peers selected; use manual handoff.';
  const values: Record<string, string> = {
    team,
    tool: tool.name,
    invocations,
    rules: plan.rules.map((r) => `- ${cell(r.text)}`).join('\n'),
    fallbacks: roles
      .map(
        (role) =>
          `- ${role}: ${plan.fallbacks[role].map((a) => `${cell(a.model)} / ${a.effort} via ${cell(a.via)}`).join(' → ') || 'No independent alternative.'}`,
      )
      .join('\n'),
    warnings: plan.warnings.length
      ? 'Warnings:\n' + plan.warnings.map((w) => '- ' + cell(w)).join('\n')
      : '',
  };
  return teamTemplate.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '').trim();
}
