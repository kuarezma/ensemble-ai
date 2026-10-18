import { z } from 'zod';
export const roles = [
  'orchestrator',
  'architect',
  'builder',
  'reviewer',
  'automator',
  'worker',
] as const;
export const RoleSchema = z.enum(roles);
export type Role = z.infer<typeof RoleSchema>;
export const EffortSchema = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const metric = z.number().finite().nonnegative().nullable();
const ratio = z.number().min(0).max(1).nullable();
export const MetricsSchema = z.object({
  intelligence: metric,
  terminalBench: ratio,
  automationBench: ratio,
  knowledgeAccuracy: ratio,
  hallucinationRate: ratio,
  outputTokensPerTask: metric,
  cost: metric,
  speed: metric,
  ttft: metric,
});
export const EffortDataSchema = z.object({
  effort: EffortSchema,
  metrics: MetricsSchema,
  source: z.url(),
  date: z.iso.date(),
  sourceSnapshot: z.string(),
  dateKind: z.enum(['imported', 'refreshed']).default('imported'),
  additionalSources: z.array(z.string()).default([]),
});
export const ModelSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  family: z.string(),
  efforts: z
    .array(EffortDataSchema)
    .min(1)
    .refine((es) => new Set(es.map((e) => e.effort)).size === es.length, 'Duplicate efforts'),
  context: metric,
  price: z.object({ input: metric, output: metric, cacheRead: metric }),
  availability: z.array(z.string()),
  availabilityEstimate: z.boolean(),
  gateableTaskTypes: z.array(z.string()),
  provisional: z.boolean(),
});
export type Model = z.infer<typeof ModelSchema>;
export type Effort = z.infer<typeof EffortSchema>;
export type Metrics = z.infer<typeof MetricsSchema>;
export const ToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  vendor: z.string(),
  platforms: z.array(z.enum(['darwin', 'win32', 'linux'])),
  format: z.literal('markdown'),
  globalPath: z.object({ darwin: z.string(), win32: z.string(), linux: z.string() }).nullable(),
  projectPath: z.string().nullable(),
  verified: z.boolean(),
  template: z.literal('team.md'),
  subagents: z.boolean().nullable(),
  cliDelegation: z.boolean().nullable(),
  headlessCli: z.string().nullable(),
  source: z.url().nullable(),
  notes: z.string(),
});
export type Tool = z.infer<typeof ToolSchema>;
export const SubscriptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  vendor: z.string(),
  via: z.string(),
  models: z.array(z.object({ model: z.string(), efforts: z.array(EffortSchema) })),
  scarcity: z.number().int().min(1).max(3),
  estimate: z.literal(true),
  notes: z.string(),
});
export const AccessibleModelSchema = ModelSchema.extend({
  via: z.string().min(1),
  scarcity: z.number().int().min(1).max(3),
});
export type AccessibleModel = z.infer<typeof AccessibleModelSchema>;
export const ModelRefSchema = z.object({
  model: z.string(),
  effort: EffortSchema.optional(),
  via: z.string().optional(),
});
export const AssignmentSchema = z.object({
  model: z.string(),
  effort: EffortSchema,
  via: z.string(),
  why: z.array(z.string()).min(1),
});
export type Assignment = z.infer<typeof AssignmentSchema>;
export const EngineInputSchema = z.object({
  accessible: z.array(AccessibleModelSchema).min(1),
  profile: z.enum(['saver', 'balanced', 'quality']),
  orchestratorOverride: ModelRefSchema.optional(),
  locks: z.partialRecord(RoleSchema, AssignmentSchema).optional(),
  tools: z.array(z.string()),
});
export type EngineInput = z.infer<typeof EngineInputSchema>;
export const RuleSchema = z.object({ id: z.string(), text: z.string() });
export const PlanSchema = z.object({
  assignments: z.record(RoleSchema, AssignmentSchema),
  fallbacks: z.record(RoleSchema, z.array(AssignmentSchema)),
  rules: z.array(RuleSchema),
  warnings: z.array(z.string()),
});
export type Plan = z.infer<typeof PlanSchema>;
export const CliConfigSchema = z.object({
  plan: PlanSchema,
  tools: z.array(z.string()).min(1),
  projectDirs: z.array(z.string()).optional(),
});
