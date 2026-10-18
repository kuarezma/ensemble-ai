# Ensemble — spec

Desktop app (macOS x64/arm64 dmg, Windows x64 NSIS exe, Linux x64 AppImage+deb) that helps people who pay for several AI
subscriptions split work across models so scarce quota is not wasted. The user says which tools/plans/models they have,
picks a profile, reviews the proposed role->model->effort plan, approves it, and Ensemble writes the rules into every
selected tool's persistent instructions/memory so every future project follows the same delegation scheme.

Default UI language English; Turkish (`tr`) selectable. All user-facing strings live in `src/renderer/i18n/{en,tr}.json`.

## Hard constraints
- Never touch the real HOME of the developer in tests or dev runs. All file-writing code takes a `homeDir` parameter; tests use a temp dir.
- No secrets, no personal paths, no telemetry. Network use only: optional model-data refresh from artificialanalysis.ai (user toggle, shown at first run, default ON but clearly explained, can be turned off), optional GitHub release check is NOT implemented.
- Writes to external tool files are limited to a managed block delimited by `<!-- ENSEMBLE:BEGIN v1 -->` / `<!-- ENSEMBLE:END -->` (or the tool's comment syntax). Content outside the block is never modified. Before the first write to a file, a backup copy goes to `<homeDir>/.ensemble/backups/<timestamp>/…`; a manifest allows one-click revert. Re-applying is idempotent.
- Pure core (`src/core`) has no Electron/DOM imports so it runs in Node tests and in a headless CLI (`ensemble apply --config plan.json --home <dir> --dry-run`).

## Stack
Electron + React + TypeScript + Vite (electron-vite), Vitest, electron-builder, GitHub Actions matrix (macos, windows, ubuntu) building installers on tag. No heavy UI kit: hand-written CSS with tokens, light/dark following the OS.

## Roles (final, minimal — do not add more)
1. `orchestrator` — the chat session the user talks to; dispatches, tracks ownership/status, never makes design decisions. Needs: cheap, fast, reliable instruction following, long-context caching friendly. Medium effort.
2. `architect` — breaks ambiguous requests down, designs interfaces/acceptance gates, resolves reviewer disagreements, decides risky merges. Needs: highest reasoning/knowledge accuracy. Output is reviewed by a different model family.
3. `builder` — implements well-specified code and fixes bugs (root cause starts with a failing regression test); escalates effort then model after 2 failed gated attempts.
4. `reviewer` — independent read-only review and acceptance-gate verification. Must be a different model family than the author of the change; needs low hallucination rate; verification only counts if executed (tests/lint/build output attached).
5. `automator` — multi-step tool use: builds, test runs, measurements, scripted workflows, and the builder fallback when the main coding quota is exhausted. Needs: strong agentic/automation benchmarks.
6. `worker` — chores: repo/log scanning, summaries, docs, mechanical edits, test scaffolding from an existing spec. Needs: cheapest abundant quota. Never UI layout/CSS, interactive debugging or anything without an automated gate.
(Designer is not a role: UI work goes to `builder` with a UI gate; brand direction for new products is an `architect` sub-task.)

Fallback is a per-role ordered chain, not a role.

## Engine (src/core/engine)
Input: `{ accessible: AccessibleModel[], profile: 'saver'|'balanced'|'quality', orchestratorOverride?: ModelRef, locks?: Partial<Record<Role, Assignment>>, tools: ToolId[] }`
where `AccessibleModel` = catalog model + `via` (which tool/plan exposes it) + `scarcity` (1 abundant … 3 scarce, from the plan tier table, editable by the user).
Output: `Plan { assignments: Record<Role, {model, effort, via, why: string[] }>, fallbacks: Record<Role, Assignment[]>, rules: Rule[], warnings: string[] }`.

Scoring per role uses catalog metrics (intelligence, terminalBench, automationBench, knowledgeAccuracy, hallucinationRate, outputTokensPerTask, speed, ttft) normalised across the user's own accessible set, then:
- `saver`: weight scarcity and tokens/task heavily, pick lowest efforts that pass the role's minimum bar; prefer abundant pools for worker/automator/orchestrator.
- `balanced`: default; medium efforts, escalate only on role need.
- `quality`: accept more tokens and scarcity for architect/builder/reviewer, higher efforts.
Hard rules (tested): (a) reviewer family != builder family when ≥2 families available, else warning; (b) architect decision is audited by a different family when possible; (c) worker never gets a model without a gate-able task type; (d) efforts only from the model's real available efforts; (e) very high efforts (xhigh/max) only if the metric gain justifies it (rule: marginal intelligence gain per extra cost) or the profile is quality AND the role is architect; (f) if user has a single model/family, produce a valid plan with warnings, not an error; (g) deterministic: same input → same output; every assignment carries human-readable `why`.
The user can override the orchestrator manually (`orchestratorOverride`) or lock any role; engine re-plans around locks.

## Catalog (data, not code) — `catalog/`
- `models.json`: families, models with efforts, metrics (+ source & date), context, price, availability by tool. Seed from the existing measured data (see "Seed data").
- `tools.json`: broad repertoire of AI coding clients with: id, name, vendor, platforms, how rules are persisted (`format`, `globalPath` per OS, `projectPath`, `verified: boolean`), whether it can launch subagents/CLI delegation, headless CLI template if any. Must include at least: Claude Code, Codex CLI, Gemini CLI, Antigravity, Cursor, Windsurf, Zed, GitHub Copilot (VS Code/JetBrains), Cline, Roo Code, Kilo Code, Continue, Aider, opencode, Goose, Amp, Kiro, Trae, Warp, JetBrains AI/Junie, Qwen Code, Droid (Factory), OpenHands, Sourcegraph Cody. Where a persistent global file is not documented, set `globalPath: null` and support project-level file or "copy rules" export; set `verified:false` honestly. Plus a universal `AGENTS.md` export.
- `plans.json`: subscription plans per vendor (Claude Pro/Max, ChatGPT Plus/Pro, Gemini/Google AI Pro/Ultra, Cursor Pro, Copilot, Windsurf, Zed, API-key) → which models/efforts are exposed and a scarcity rating. Mark `estimate:true`; do not claim exact limits. No quota tracking anywhere.
- `rules-template/`: Markdown templates (en) rendered per tool: team table (role → model/effort, how to invoke from that tool given installed peers), escalation ladder, "same family never reviews itself", 2-attempt cap, handoff package, "update HANDOFF/NEXT line" convention, language note.

## Model data refresh (src/core/aa)
Opt-in module: fetch `https://artificialanalysis.ai/models` pages (or the documented API when the user pastes an API key; store key only in OS keychain via `safeStorage`/Electron, never in plain config), parse embedded model JSON (technique: regex-locate `{"slug":"…","name":"…","shortName"` objects in the Next.js payload and decode with a JSON decoder; see `docs/AA-FORMAT.md` for field names: intelligenceIndex, terminalBench40, automationBenchPartialScore, omniscienceAccuracy, omniscienceHallucinationRate, intelligenceIndexOutputTokensPerTask, intelligenceIndexCost.total, medianOutputTokensPerSecond, effort.slug, price1mInputTokens/OutputTokens). Cache to `<userData>/aa-cache.json`, at most one refresh per 24h, polite User-Agent, attribution shown in UI ("Data: Artificial Analysis"). New models not in `models.json` become `provisional: true`; the UI asks the user to tick which tools expose them; the engine then regenerates the plan automatically and shows a diff ("what changed and why") for approval before anything is re-applied. Parsing must be unit-tested against recorded fixtures (offline), never against the live site in tests.

## Apply pipeline (src/core/apply)
`buildApplyPreview(plan, selectedTools, homeDir, projectDirs?) -> FileChange[]` (path, before, after, unified diff) → user approves → `applyChanges()` (backup + atomic write + manifest) → `verify()` re-reads and checks the block → `revert(manifestId)`.
Also writes Claude Code subagent files (`~/.claude/agents/ensemble-<role>.md` with model/effort frontmatter) when Claude Code is selected, with the same backup/revert guarantees. Windows paths via `%USERPROFILE%`/`%APPDATA%`; no shell calls for writing.

## UI (src/renderer) — calm, premium, minimal
Single-window wizard + a persistent summary rail:
1 Welcome (language EN/TR, data-refresh consent toggle) → 2 Your tools (searchable grid of tools, checkboxes; per tool pick plan from dropdown; models auto-listed with checkboxes to hide ones the user cannot use) → 3 Style (three big cards: Saver / Balanced / Quality with one-line plain-language promise; Auto or "I choose the orchestrator" switch) → 4 Your crew (six role cards: role in plain words, model, effort chip, a one-sentence why, fallback chain on expand; every card has Change/Lock) → 5 Apply (per-tool checklist, diff preview, "What will happen" in plain language, Apply, then success screen with Revert). Settings: language, theme, data refresh (+ API key), export `AGENTS.md`, import/export plan JSON.
Design: spacious layout, 8px grid, tokens on `:root`, light/dark, keyboard accessible, `prefers-reduced-motion`, no horizontal overflow at 360px width of the window content, axe-clean. Tone of copy: short, friendly, no jargon; every technical term has a tooltip.

## Seed data
Catalog numbers come from Artificial Analysis model pages (independent benchmarks) plus the authors' own gated test runs; every metric carries `source` and date. No personal data or local paths belong in the catalog.

## Tests (Vitest) — must be green before done
Engine hard rules (a)–(g) + determinism + single-family plan + each profile differs; apply: marker idempotence, content outside block untouched, backup+revert round trip, CRLF files, missing file creation, unicode paths; AA parser on fixtures + provisional-model diff; catalog schema validation (zod) incl. every tool has a template and verified flag; i18n: en and tr have identical keys; UI smoke test (Playwright or vitest+jsdom) for wizard happy path.

## Deliverables
Working app (`npm run dev`, `npm run build`, `npm run dist`), CLI, tests green, README (EN, with TR section), LICENSE (MIT), CONTRIBUTING, docs/ARCHITECTURE.md, `.github/workflows/{ci,release}.yml`, `electron-builder.yml`.
