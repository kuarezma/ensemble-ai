/* global document */
import { _electron as electron } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const runs = Number(process.argv[2] ?? 5);
const packagedBinary = process.argv[3];
const results = [];
for (let i = 0; i < runs; i++) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ensemble-perf-'));
  const t0 = performance.now();
  const app = await electron.launch({
    ...(packagedBinary ? { executablePath: packagedBinary } : { args: ['.'] }),
    env: { ...process.env, ENSEMBLE_HOME: home },
  });
  const tLaunched = performance.now() - t0;
  const page = await app.firstWindow();
  const tWindow = performance.now() - t0;
  await page.waitForSelector('h1');
  const tH1 = performance.now() - t0;
  let tVisible = -1;
  for (;;) {
    const visible = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((w) => w.isVisible()),
    );
    if (visible) {
      tVisible = performance.now() - t0;
      break;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (b) => /Continue/.test(b.innerText) && !b.disabled,
    ),
  );
  const tInteractive = performance.now() - t0;
  results.push({ tLaunched, tWindow, tH1, tVisible, tInteractive });
  await app.close();
}
const med = (k) => {
  const v = results.map((r) => r[k]).sort((a, b) => a - b);
  return Math.round(v[Math.floor(v.length / 2)]);
};
console.log(
  JSON.stringify({
    runs,
    medianMs: {
      launched: med('tLaunched'),
      firstWindow: med('tWindow'),
      h1Rendered: med('tH1'),
      windowVisible: med('tVisible'),
      interactive: med('tInteractive'),
    },
  }),
);
