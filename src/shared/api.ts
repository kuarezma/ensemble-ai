import type { models, tools, subscriptions } from '../core/catalog.js';
import type { EngineInput, Model, Plan } from '../core/schemas.js';
export type Catalog = {
  models: typeof models;
  tools: typeof tools;
  subscriptions: typeof subscriptions;
  platform: string;
  sandbox: boolean;
};
export type Preview = {
  id: string;
  files: { path: string; diff: string }[];
  exports: { tool: string; content: string; reason: string }[];
};
export interface EnsembleAPI {
  catalog(): Promise<Catalog>;
  plan(input: EngineInput): Promise<Plan>;
  preview(tools: string[]): Promise<Preview>;
  apply(id: string): Promise<{ manifestId: string | null; verified: boolean }>;
  revert(id: string): Promise<void>;
  refresh(consent: boolean): Promise<{ models: Model[]; changes: number }>;
  setKey(key: string): Promise<void>;
  copy(text: string): Promise<void>;
}
declare global {
  interface Window {
    ensemble: EnsembleAPI;
  }
}
