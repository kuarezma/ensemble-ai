import { expect, it } from 'vitest';
import en from '../src/renderer/i18n/en.json' with { type: 'json' };
import tr from '../src/renderer/i18n/tr.json' with { type: 'json' };
import { explain } from '../src/renderer/explain.js';
it('ships identical, nonempty English and Turkish keys', () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(tr).sort());
  for (const dictionary of [en, tr])
    for (const value of Object.values(dictionary)) expect(value.trim().length).toBeGreaterThan(0);
});

it('explains Phase C decisions and evidence limits in both languages', () => {
  const examples = [
    'balanced: builder selected for its role requirements.',
    'Uses measured TerminalBench performance per scarce quota, with automated gates.',
    'Balanced uses normal operating efforts and saves scarce Claude quota for difficult decisions.',
    'Effort medium uses its published catalog measurements.',
    'Effort medium has gated operational evidence only; high benchmarks are a model-level proxy, not measurements of medium.',
    'Replan the reviewer from a different family before using this builder fallback.',
    'worker: no abundant pool is available; using the cheapest qualifying accessible option.',
    'automator: Argon medium has operational evidence only; its benchmark measurements are unavailable.',
  ];
  for (const dictionary of [en, tr]) {
    const t = (key: keyof typeof en) => dictionary[key];
    for (const example of examples) {
      const result = explain(example, t);
      expect(result).not.toBe(dictionary.reasonGeneric);
      expect(result).not.toMatch(/\{\w+\}|capacity limits|scarcity \d\/3|kapasite kısıtı/);
    }
  }
});
