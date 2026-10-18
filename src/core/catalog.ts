import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ModelSchema, SubscriptionSchema, ToolSchema } from './schemas.js';
// Source and compiled core share the same depth relative to the catalog directory.
const catalogRoot = new URL('../../catalog/', import.meta.url);
function read(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, catalogRoot), 'utf8'));
}
export const models = z.array(ModelSchema).parse(read('models.json'));
export const tools = z.array(ToolSchema).parse(read('tools.json'));
export const subscriptions = z.array(SubscriptionSchema).parse(read('plans.json'));
export const teamTemplate = readFileSync(new URL('rules-template/team.md', catalogRoot), 'utf8');
