import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach } from 'vitest';
import { models } from '../src/core/catalog.js';
import { generatePlan } from '../src/core/engine/index.js';
import type { AccessibleModel, EngineInput } from '../src/core/schemas.js';
const temps: string[] = [];
export async function tempHome(): Promise<string> {
  await mkdir(path.resolve('.dev-data'), { recursive: true });
  const dir = await mkdtemp(path.resolve('.dev-data/ensemble-test-'));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
export function access(): AccessibleModel[] {
  return models.map((m) => ({
    ...structuredClone(m),
    via: m.family === 'claude' ? 'claude-code' : m.family === 'gpt' ? 'codex-cli' : 'opencode',
    scarcity: m.family === 'claude' ? 3 : m.family === 'gpt' ? 2 : 1,
  }));
}
export function input(profile: EngineInput['profile'] = 'balanced'): EngineInput {
  return { accessible: access(), profile, tools: ['claude-code', 'codex-cli'] };
}
export const plan = () => generatePlan(input());
