import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { tools } from '../catalog.js';
import { renderRules } from '../rules.js';
import { PlanSchema, roles, type Plan } from '../schemas.js';
import { managedBlock, updateManagedBlock } from './markers.js';
import { absoluteRoot, assertSafePath, resolveToolPath } from './paths.js';
export type FileChange = {
  path: string;
  root: string;
  before: string | null;
  after: string;
  diff: string;
};
export type ApplyPreview = FileChange[] & {
  warnings: string[];
  exports: { tool: string; content: string; reason: string }[];
};
export async function readOptional(file: string): Promise<string | null> {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function buildApplyPreview(
  rawPlan: Plan,
  selectedTools: string[],
  homeDir: string,
  projectDirs: string[] = [],
  platform: NodeJS.Platform = process.platform,
): Promise<ApplyPreview> {
  const plan = PlanSchema.parse(rawPlan),
    home = absoluteRoot(homeDir);
  const changes = [] as unknown as ApplyPreview;
  changes.exports = [];
  changes.warnings = [];
  const targets = new Map<string, { root: string; body: string; frontmatter?: string }>();
  function add(file: string, root: string, body: string, frontmatter?: string) {
    const old = targets.get(file);
    if (old && old.body !== body)
      throw new Error('Multiple tools target the same file with different rules');
    targets.set(file, { root, body, frontmatter });
  }
  for (const id of [...new Set(selectedTools)]) {
    const tool = tools.find((t) => t.id === id);
    if (!tool) throw new Error(`Unknown tool: ${id}`);
    const body = renderRules(plan, tool, selectedTools);
    const global = tool.globalPath?.[platform as 'darwin' | 'linux' | 'win32'];
    if (tool.verified && global) add(resolveToolPath(home, global), home, body);
    if (tool.verified && tool.projectPath)
      for (const project of projectDirs) {
        const root = absoluteRoot(project);
        add(resolveToolPath(root, tool.projectPath), root, body);
      }
    if (!tool.verified || (!global && !projectDirs.length))
      changes.exports.push({
        tool: id,
        content: body,
        reason: 'No verified writable location selected; copy rules explicitly.',
      });
    if (id === 'claude-code')
      for (const role of roles) {
        const a = plan.assignments[role];
        // YAML strings are JSON quoted to avoid frontmatter injection. Provider IDs require client confirmation.
        const native = a.via === 'claude-code' && a.model.startsWith('claude-');
        const frontmatter = `name: ensemble-${role}\ndescription: ${JSON.stringify('Ensemble ' + role + '; configured pool ' + a.via)}\nmodel: ${JSON.stringify(native ? a.model : 'inherit')}\neffort: ${JSON.stringify(native ? a.effort : 'medium')}`;
        const target = resolveToolPath(home, `.claude/agents/ensemble-${role}.md`);
        add(
          target,
          home,
          `${body}\n\n${native ? 'Native Claude agent.' : 'Dispatcher only: hand work to ' + a.model + ' / ' + a.effort + ' via ' + a.via + '. Do not perform the assigned external work using the inherited model.'}\nAssigned role: ${role}. ${role === 'reviewer' ? 'Read-only: report findings; never edit files.' : ''}`,
          frontmatter,
        );
      }
  }
  for (const [file, { root, body, frontmatter }] of targets) {
    await assertSafePath(root, file);
    const before = await readOptional(file);
    if (before !== null && (await stat(file)).nlink > 1)
      changes.warnings.push(`Hard-linked target will be replaced independently: ${file}`);
    let content = before;
    if (frontmatter) {
      const begin = '# ENSEMBLE:BEGIN v1',
        end = '# ENSEMBLE:END';
      if (content === null)
        content = '---\n' + updateManagedBlock(null, frontmatter, begin, end) + '---\n';
      else {
        if (!content.startsWith('---') || !managedBlock(content, begin, end))
          throw new Error('Existing unmanaged subagent file: ' + path.basename(file));
        content = updateManagedBlock(content, frontmatter, begin, end);
      }
    }
    const after = updateManagedBlock(content, body);
    if (before !== after)
      changes.push({
        path: file,
        root,
        before,
        after,
        diff: createTwoFilesPatch(file, file, before ?? '', after),
      });
  }
  return changes;
}

/** Exact paths the catalog-backed writers can produce, including native Claude agents. */
export function writableTargets(home: string, projects: string[]): Set<string> {
  const targets = new Set<string>();
  for (const tool of tools) {
    if (!tool.verified) continue;
    for (const template of Object.values(tool.globalPath ?? {}))
      if (template) targets.add(resolveToolPath(home, template));
    if (tool.projectPath)
      for (const project of projects)
        targets.add(resolveToolPath(absoluteRoot(project), tool.projectPath));
    if (tool.id === 'claude-code')
      for (const role of roles)
        targets.add(resolveToolPath(home, `.claude/agents/ensemble-${role}.md`));
  }
  return targets;
}
