# Phase A architecture

`schemas.ts` defines the six roles, measured model/effort data, tool/plan metadata, engine input,
plan and CLI configuration with Zod. `catalog.ts` loads bundled data relative to its module;
source and compiled layouts both resolve the root catalog. No source-machine paths are used at runtime.

`engine/index.ts` is deterministic and side-effect free. Every metric is min/max normalized over
all effort variants in the user's accessible pools. Beneficial metrics reward high values; cost-like
metrics reward low values. A missing value receives the least favorable normalized contribution.
Equal measured values receive 0.5. Weight tables and minimum intelligence bars are exported/in source.

Role weights distinguish knowledge/reasoning, code, automation and economical throughput. Saver
selects each model/pool's lowest eligible measured effort before comparing candidates, with strong
scarcity/output-token penalties. Balanced centers on medium effort. Quality reduces conservation
penalties and favors quality metrics. If no model passes a role bar, choose the best eligible one
with a warning; worker eligibility itself requires a gate-able task type. User locks remain fixed;
a locked reviewer constrains an unlocked builder. Impossible dual-family locks are rejected rather
than silently changed. A single eligible family remains usable with independence warnings.

For xhigh/max escalation, marginal intelligence gain divided by log2(cost ratio) must be >=5,
or cost must not increase while intelligence improves. Quality architects may bypass this test.
A sole measured tier is treated as the model's native tier, not an effort escalation: retain it
with an explicit unknown-marginal-gain warning so max-only accessible models remain usable.
Ties are broken by stable model/pool/effort IDs, never randomness or current time. Fallbacks are
ranked distinct model/pool pairs and preserve eligibility; builder/reviewer alternatives respect
the currently assigned counterpart. Replan before changing authors; architect audit is a required
rule plus an explicit different-family instruction, not a seventh role.

`rules.ts` renders the shared English Markdown template for every catalog tool. It uses selected
peers' documented CLI templates or manual handoff guidance and never executes commands. Canonical
AA names are not guaranteed to be vendor API IDs; the text requires client-side confirmation.

`aa/index.ts` locates model-object signatures, scans balanced JSON boundaries respecting strings,
and decodes with JSON.parse. HTML string wrappers are decoded first. Explicit effort fields,
slug suffixes and effort labels in model names are recognized; unknown efforts are rejected.
The normalizer maps known source slugs back to existing model identities and translates hallucination
complements. Refresh merges effort metrics without overwriting user access and returns a diff;
provisional models have no default access/gated-task capabilities. `aa/refresh.ts` is optional,
consent-gated, transport-injectable and caches raw records for 24h. Live parser compatibility and
API-key/keychain storage are outside Phase A proof.

`apply/writers.ts` resolves only documented paths from an explicitly supplied HOME and optional
project roots. Unknown clients return copy exports. Markdown uses HTML comment markers; Claude YAML
uses YAML comment markers inside frontmatter. `markers.ts` reconstructs a proposed result using only
managed-block changes and rejects edits elsewhere. Existing non-Ensemble subagent frontmatter is refused.

`apply/index.ts` serializes cooperating writers with an exclusive HOME lock. It preflights all files,
backs up originals, writes a prepared manifest with checksums before touching targets, uses exclusive
same-directory temp files, fsyncs content, renames, verifies and finalizes the manifest. A later failure
rolls back earlier writes while retaining recovery artifacts. Revert checks all conflicts and backup
checksums before restoring; subsequent edits are never overwritten. Prepared manifests permit recovery
from interrupted applies. New files are removed by revert; empty created directories remain. Existing
permission bits are retained; ACLs, ownership and extended attributes are not preserved. Independent
project/HOME processes and hostile directory swaps are not a filesystem-wide atomic transaction.

`cli.ts` validates JSON and requires an explicit HOME for all writes. `bin/ensemble` loads compiled
core; `plan` outputs an apply-ready wrapper. Electron imports appear only under main/preload. The
Phase A main stub creates no window, IPC, network requests or rule writes. In dev its data/log paths
are project-local. Config automatically includes the renderer once Phase B adds index.html.

Tests use os.tmpdir(), clean up their fixtures and never infer or write a real HOME. Coverage includes
engine rules/profiles/locks, exact source numbers, real recorded parser payloads, stale previews,
revert conflicts, simulated write failure/rollback, prepared recovery, symlink/path defenses, CLI and
consented cached refresh. Renderer, i18n and wizard smoke checks are deferred together to Phase B.
