// Manual check: do the installed CLIs load Ensemble's global rules from a sandbox HOME?
// Every CLI runs with a minimal environment whose HOME and config-dir variables point at a
// throwaway directory; the real HOME is never written. CLIs that keep credentials under HOME
// usually cannot authenticate there, which is reported as "failed", never as verified.
// Usage: npm run build:core && node scripts/verify-persistence.mjs [--keep]
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { models } from '../dist/core/catalog.js';
import { generatePlan } from '../dist/core/engine/index.js';
import { applyChanges, buildApplyPreview, verifyToolTargets } from '../dist/core/apply/index.js';

const crew = ['claude-code', 'codex-cli', 'gemini-cli', 'opencode', 'antigravity'];
const TIMEOUT_MS = 120_000;
// Outside the checkout so no ancestor CLAUDE.md or AGENTS.md can supply the answer.
const base = await mkdtemp(path.join(os.tmpdir(), 'ensemble-persist-'));
const home = path.join(base, 'home'),
  work = path.join(base, 'work'),
  temp = path.join(base, 'tmp');
await Promise.all([home, work, temp].map((dir) => mkdir(dir)));

const nonce = 'ENS-' + randomUUID().slice(0, 8);
const generated = generatePlan({
  accessible: models
    .filter((model) => ['claude-opus-5-5', 'gpt-6-1-sol', 'gemini-3-8-flash'].includes(model.id))
    .map((model) => ({
      ...model,
      via:
        model.family === 'claude'
          ? 'claude-code'
          : model.family === 'gpt'
            ? 'codex-cli'
            : 'gemini-cli',
      scarcity: model.family === 'claude' ? 3 : model.family === 'gpt' ? 2 : 1,
    })),
  profile: 'balanced',
  tools: ['claude-code', 'codex-cli', 'gemini-cli'],
});
const plan = {
  ...generated,
  rules: [...generated.rules, { id: 'verification', text: `Verification code: ${nonce}` }],
};
await applyChanges(await buildApplyPreview(plan, crew, home), home);
const written = await verifyToolTargets(plan, crew, home);
const reviewer = plan.assignments.reviewer.model;

const env = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local/share'),
  XDG_STATE_HOME: path.join(home, '.local/state'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  CODEX_HOME: path.join(home, '.codex'),
  TMPDIR: temp,
  NO_COLOR: '1',
  TERM: 'dumb',
};
const prompt =
  'Answer only from the instructions loaded at startup; do not read files or run tools. ' +
  'Reply on one line with the Ensemble verification code, then the model assigned to the ' +
  'reviewer role. If you have no Ensemble instructions, reply NONE.';
const clients = [
  { tool: 'claude-code', command: 'claude', args: ['-p', prompt] },
  { tool: 'codex-cli', command: 'codex', args: ['exec', '--skip-git-repo-check', prompt] },
  { tool: 'gemini-cli', command: 'gemini', args: ['-p', prompt] },
  { tool: 'opencode', command: 'opencode', args: ['run', prompt] },
  { tool: 'antigravity', command: 'agy', args: ['-p', prompt] },
];
function run(command, args) {
  return new Promise((resolve) => {
    let stdout = '',
      stderr = '';
    const child = spawn(command, args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, missing: error.code === 'ENOENT' });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, missing: false });
    });
  });
}
const lastLine = (text) =>
  text.trim().split('\n').filter(Boolean).at(-1)?.replaceAll(base, '<sandbox>').slice(0, 200) ?? '';
const rows = [];
for (const client of clients) {
  const file = written.find((r) => r.tool === client.tool);
  const result = await run(client.command, client.args);
  let status, evidence;
  if (result.missing) [status, evidence] = ['not-installed', ''];
  else if (result.code !== 0)
    [status, evidence] = [
      result.signal ? 'timeout' : 'failed',
      lastLine(result.stderr) || lastLine(result.stdout),
    ];
  else if (result.stdout.includes(nonce) && result.stdout.includes(reviewer))
    [status, evidence] = ['verified', lastLine(result.stdout)];
  else [status, evidence] = ['not-loaded', lastLine(result.stdout)];
  rows.push({ tool: client.tool, file: file?.status, status, evidence });
}
console.log(JSON.stringify({ nonce, reviewer, rows }, null, 2));
if (!process.argv.includes('--keep')) await rm(base, { recursive: true, force: true });
else console.log('Sandbox kept at ' + base);
