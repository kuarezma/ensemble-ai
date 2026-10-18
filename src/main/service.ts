import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { models, tools, subscriptions } from '../core/catalog.js';
import { EngineInputSchema, type Plan } from '../core/schemas.js';
import { generatePlan } from '../core/engine/index.js';
import {
  buildApplyPreview,
  applyChanges,
  revert,
  type ApplyPreview,
  ApplyRecoveryError,
  listRecoveryManifests,
} from '../core/apply/index.js';
import { absoluteRoot } from '../core/apply/paths.js';
import type { Preview } from '../shared/api.js';
export function targetHome(packaged: boolean, realHome: string, cwd: string, override?: string) {
  return absoluteRoot(override || (packaged ? realHome : path.join(cwd, '.sandbox-home')));
}
const ToolIds = z
  .array(z.string())
  .min(1)
  .max(50)
  .refine((ids) => ids.every((id) => tools.some((t) => t.id === id)), 'Unknown tool');
/** Only server-owned previews can reach the core writer. Each preview is single use. */
export function createService(home: string) {
  let current: Plan | undefined;
  let pending: { id: string; changes: ApplyPreview } | undefined;
  let busy = false;

  function idle() {
    if (busy) throw new Error('Operation in progress');
  }
  return {
    catalog: () => ({ models, tools, subscriptions }),
    recoveries: () => listRecoveryManifests(home),
    plan(raw: unknown) {
      idle();
      pending = undefined;
      current = generatePlan(EngineInputSchema.parse(raw));
      return current;
    },
    async preview(raw: unknown): Promise<Preview & { warnings: string[] }> {
      idle();
      busy = true;
      pending = undefined;
      try {
        if (!current) throw new Error('Create a plan first');
        const ids = ToolIds.parse(raw);
        const changes = await buildApplyPreview(current, ids, home);
        const id = randomUUID();
        pending = { id, changes };
        return {
          id,
          files: changes.map((c) => ({
            path: path.relative(home, c.path),
            diff: c.diff.replaceAll(home, '~'),
          })),
          exports: changes.exports,
          warnings: changes.warnings,
        };
      } finally {
        busy = false;
      }
    },
    async apply(raw: unknown) {
      idle();
      const id = z.string().uuid().parse(raw);
      if (!pending || pending.id !== id) throw new Error('Preview expired');
      busy = true;
      const changes = pending.changes;
      pending = undefined;
      try {
        const manifest = await applyChanges(changes, home);
        return { manifestId: manifest?.id ?? null, verified: true };
      } catch (error) {
        if (error instanceof ApplyRecoveryError)
          return { manifestId: error.manifestId, verified: false, error: error.message };
        throw error;
      } finally {
        busy = false;
      }
    },
    async revert(raw: unknown) {
      idle();
      const id = z.string().parse(raw);
      busy = true;
      pending = undefined;
      try {
        if (!(await listRecoveryManifests(home)).some((m) => m.id === id))
          throw new Error('Unknown transaction');
        await revert(id, home);
      } finally {
        busy = false;
      }
    },
  };
}
