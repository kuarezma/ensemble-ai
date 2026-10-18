import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { CliConfigSchema, EngineInputSchema } from './schemas.js';
import { generatePlan } from './engine/index.js';
import { applyChanges, buildApplyPreview, revert } from './apply/index.js';
export async function runCLI(
  args: string[],
  stdout: (text: string) => void = console.log,
): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string' },
      home: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'manifest-id': { type: 'string' },
      project: { type: 'string', multiple: true },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !positionals.length) {
    stdout(
      'ensemble plan --config input.json\nensemble apply --config plan.json --home <explicit-dir> [--project <dir>] [--dry-run]\nensemble revert --manifest-id <id> --home <explicit-dir> [--project <dir>]',
    );
    return;
  }
  if (positionals.length !== 1) throw new Error('Expected one command');
  const command = positionals[0];
  if (command === 'revert') {
    if (!values.home || !values['manifest-id'])
      throw new Error('revert requires --home and --manifest-id');
    stdout(
      JSON.stringify(await revert(values['manifest-id'], values.home, values.project), null, 2),
    );
    return;
  }
  if (!['plan', 'apply'].includes(command!)) throw new Error('Unknown command');
  if (!values.config) throw new Error('--config is required');
  const raw: unknown = JSON.parse(await readFile(values.config, 'utf8'));
  if (command === 'plan') {
    const input = EngineInputSchema.parse(raw);
    stdout(JSON.stringify({ plan: generatePlan(input), tools: input.tools }, null, 2));
    return;
  }
  if (!values.home) throw new Error('Explicit --home is required; real HOME is never inferred');
  const config = CliConfigSchema.parse(raw);
  const projects = values.project ?? config.projectDirs;
  const preview = await buildApplyPreview(config.plan, config.tools, values.home, projects);
  if (values['dry-run']) {
    stdout(JSON.stringify({ changes: preview, exports: preview.exports }, null, 2));
    return;
  }
  const manifest = await applyChanges(preview, values.home, projects);
  stdout(JSON.stringify({ manifest, exports: preview.exports }, null, 2));
}
