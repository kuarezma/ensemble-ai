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
export type UpdateState = {
  currentVersion: string;
  enabled: boolean;
  status:
    'idle' | 'dev' | 'checking' | 'up-to-date' | 'downloading' | 'ready' | 'available' | 'error';
  version?: string;
  percent?: number;
};
export type UpdateAction =
  | { type: 'status' | 'check' | 'restart' | 'download' | 'notes' }
  | { type: 'configure'; enabled: boolean };
export interface EnsembleAPI {
  update(action: UpdateAction): Promise<UpdateState>;
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
