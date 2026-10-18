import { PlanSchema, roles } from '../src/core/schemas.js';
export function recoveryPlan() {
  return PlanSchema.parse({
    assignments: Object.fromEntries(
      roles.map((role) => [
        role,
        {
          model: 'claude-sonnet-5-5',
          effort: 'medium',
          via: 'claude-code',
          why: ['Recovery fixture'],
        },
      ]),
    ),
    fallbacks: Object.fromEntries(roles.map((role) => [role, []])),
    rules: [],
    warnings: [],
  });
}

// Use one valid model to isolate recovery tests from ongoing engine/catalog work.
import modelsJSON from '../catalog/models.json' with { type: 'json' };
import toolsJSON from '../catalog/tools.json' with { type: 'json' };
import subscriptionsJSON from '../catalog/plans.json' with { type: 'json' };
import { ModelSchema, ToolSchema, SubscriptionSchema } from '../src/core/schemas.js';
import { z } from 'zod';
export const recoveryModels = [ModelSchema.parse(modelsJSON[0])];
export const recoveryTools = z.array(ToolSchema).parse(toolsJSON);
export const recoverySubscriptions = z.array(SubscriptionSchema).parse(subscriptionsJSON);
