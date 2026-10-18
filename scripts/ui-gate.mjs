import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { models, tools, subscriptions } from '../dist/core/catalog.js';
import { generatePlan } from '../dist/core/engine/index.js';
import { buildApplyPreview, applyChanges, verify, revert } from '../dist/core/apply/index.js';
const root = path.resolve('out/renderer');
const output = path.resolve('docs/screenshots');
await mkdir(output, { recursive: true });
await mkdir('.dev-data', { recursive: true });
const home = await mkdtemp(path.resolve('.dev-data/ui-gate-'));
const tempDir = path.resolve('.dev-data/browser-temp');
await mkdir(tempDir, { recursive: true });
process.env.TMPDIR = tempDir;
process.env.TMP = tempDir;
process.env.TEMP = tempDir;
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [],
  errors = [];
let applyCount = 0,
  revertCount = 0;
let browser;
let status = 'passed';
let failure;
try {
  browser = await chromium.launch({
    headless: true,
    env: { ...process.env, HOME: home },
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  for (const width of [360, 390, 768, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    let plan,
      pending,
      sequence = 0;
    const newModel = {
      ...structuredClone(models[0]),
      id: 'provisional-test-model',
      name: 'New research model',
      provisional: true,
      availability: [],
    };
    await page.exposeFunction('ensembleInvoke', async (method, args) => {
      switch (method) {
        case 'catalog':
          return { models, tools, subscriptions, platform: 'linux', sandbox: true };
        case 'plan':
          plan = generatePlan(args[0]);
          pending = undefined;
          return plan;
        case 'preview':
          pending = {
            id: `preview-${++sequence}`,
            changes: await buildApplyPreview(plan, args[0], home),
          };
          return {
            id: pending.id,
            files: pending.changes.map((c) => ({
              path: path.relative(home, c.path),
              diff: c.diff.replaceAll(home, '~'),
            })),
            exports: pending.changes.exports,
          };
        case 'apply': {
          if (!pending || args[0] !== pending.id) throw new Error('Expired preview');
          const changes = pending.changes;
          pending = undefined;
          const manifest = await applyChanges(changes, home);
          applyCount++;
          return { manifestId: manifest?.id ?? null, verified: await verify(changes) };
        }
        case 'revert':
          await revert(args[0], home);
          revertCount++;
          return;
        case 'refresh':
          return { models: args[0] ? [...models, newModel] : models, changes: args[0] ? 1 : 0 };
        case 'copy':
          return;
        case 'setKey':
          return;
        default:
          throw new Error('Unknown method');
      }
    });
    await page.addInitScript(() => {
      window.ensemble = Object.fromEntries(
        ['catalog', 'plan', 'preview', 'apply', 'revert', 'refresh', 'copy', 'setKey'].map(
          (method) => [method, (...args) => window.ensembleInvoke(method, args)],
        ),
      );
    });
    async function inspect(state) {
      await page.evaluate(() => document.fonts.ready);
      const dimensions = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      const axe = await new AxeBuilder({ page }).analyze();
      const serious = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
      const result = {
        width,
        state,
        ...dimensions,
        serious: serious.length,
        violations: serious.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
      };
      results.push(result);
      await page.screenshot({ path: path.join(output, `${width}-${state}.png`), fullPage: true });
      if (dimensions.scrollWidth > dimensions.clientWidth || serious.length)
        throw new Error(JSON.stringify(result));
    }
    await page.goto(base);
    await page.getByRole('button', { name: /Continue/ }).waitFor();
    await inspect('01-welcome');
    await page.getByRole('button', { name: /Continue/ }).click();
    await page.getByRole('checkbox', { name: 'Claude Code', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Codex CLI', exact: true }).check();
    await inspect('02-tools');
    await page.getByRole('button', { name: /Continue/ }).click();
    await page.getByRole('button', { name: 'I choose the coordinator', exact: true }).click();
    await inspect('03-style');
    await page.getByRole('button', { name: /Continue/ }).click();
    await page.getByRole('heading', { name: 'Meet your crew.' }).waitFor();
    await page.getByRole('button', { name: 'Change', exact: true }).first().click();
    await inspect('04-crew');
    await page.getByRole('button', { name: /Continue/ }).click();
    await page.getByRole('button', { name: 'Preview changes' }).click();
    await page.getByRole('button', { name: 'Apply to selected tools' }).waitFor();
    await inspect('05-diff');
    if (applyCount !== revertCount) throw new Error('Apply happened before explicit click');
    await page.getByRole('button', { name: 'Apply to selected tools' }).click();
    await page.getByRole('heading', { name: 'Your crew is ready.' }).waitFor();
    await inspect('06-success');
    await page.getByRole('button', { name: 'Revert changes' }).click();
    await page
      .getByText('Changes reverted. Your original files are restored.', { exact: true })
      .waitFor();
    await page.getByRole('button', { name: /Settings/ }).click();
    await page.getByRole('combobox', { name: 'Appearance' }).selectOption('dark');
    await inspect('07-settings-dark');
    await page.getByRole('button', { name: 'Refresh model data' }).click();
    await page.getByRole('heading', { name: 'New models need your confirmation' }).waitFor();
    const fresh = page.getByRole('group', { name: 'New research model' });
    await fresh.getByRole('checkbox', { name: 'Codex CLI', exact: true }).check();
    await page.getByRole('button', { name: 'Review updated crew' }).click();
    await page.getByRole('heading', { name: 'What changed and why' }).waitFor();
    await inspect('08-refresh-diff-dark');
    await page.getByRole('button', { name: 'Accept updated plan' }).click();
    await page.getByRole('heading', { name: 'Meet your crew.' }).waitFor();
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('tr');
    await inspect('09-crew-tr-dark');
    await context.close();
  }
  if (errors.length) throw new Error('Console errors: ' + errors.join('\n'));
} catch (error) {
  status = 'failed';
  failure = error.message.includes('bootstrap_check_in')
    ? 'Chromium launch blocked by macOS sandbox: bootstrap_check_in Permission denied (1100).'
    : error.message.replaceAll(process.cwd(), '<project>');
  throw new Error(failure);
} finally {
  await writeFile(
    path.join(output, 'gate-results.json'),
    JSON.stringify(
      {
        status,
        failure,
        cases: results.length,
        applyCount,
        revertCount,
        consoleErrors: errors,
        results,
      },
      null,
      2,
    ) + '\n',
  );
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
console.log(
  `UI_GATE_OK cases=${results.length} widths=360,390,768,1280 overflow=0 axe_serious_critical=0 console_errors=${errors.length} apply=${applyCount} revert=${revertCount}`,
);
const readme = await readFile('README.md', 'utf8');
const begin = '<!-- ENSEMBLE:UI-SCREENSHOTS:BEGIN -->';
const end = '<!-- ENSEMBLE:UI-SCREENSHOTS:END -->';
const screenshotSection = `${begin}\n![Welcome at desktop width](docs/screenshots/1280-01-welcome.png)\n\n![Crew on mobile in Turkish dark mode](docs/screenshots/390-09-crew-tr-dark.png)\n\n![Review changes before Apply](docs/screenshots/1280-05-diff.png)\n${end}`;
if (readme.includes(begin) && readme.includes(end)) {
  await writeFile(
    'README.md',
    readme.slice(0, readme.indexOf(begin)) +
      screenshotSection +
      readme.slice(readme.indexOf(end) + end.length),
  );
}
