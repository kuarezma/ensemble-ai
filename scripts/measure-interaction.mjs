/* global document, requestAnimationFrame */
import { _electron as electron } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await mkdtemp(path.join(os.tmpdir(), 'ensemble-perf-'));
const app = await electron.launch({ args: ['.'], env: { ...process.env, ENSEMBLE_HOME: home } });
const page = await app.firstWindow();
await page.waitForSelector('h1');
await page.waitForFunction(() =>
  [...document.querySelectorAll('button')].some((b) => /Continue/.test(b.innerText) && !b.disabled),
);
// Time from the click handler to the next frame that shows the new step heading.
const timings = await page.evaluate(async () => {
  const out = [];
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const click = async (label) => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => label.test(b.innerText) && !b.disabled,
    );
    const before = document.querySelector('h1')?.textContent;
    const t0 = performance.now();
    button.click();
    for (let i = 0; i < 200 && document.querySelector('h1')?.textContent === before; i++)
      await nextFrame();
    out.push(Math.round(performance.now() - t0));
  };
  await click(/Continue/);
  for (const name of ['Claude Code', 'Codex CLI']) {
    const box = [...document.querySelectorAll('input[type=checkbox]')].find((i) =>
      i.closest('label,div')?.textContent?.includes(name),
    );
    box?.click();
    await nextFrame();
  }
  await click(/Continue/);
  await click(/Continue/);
  await click(/Continue/);
  return out;
});
console.log(JSON.stringify({ stepSwitchMs: timings }));
await app.close();
