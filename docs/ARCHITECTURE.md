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

## Phase E: icons, updates and release metadata

The source brand is `build/icon.svg`; `build/icon.png` is its 1024×1024 raster counterpart.
`directories.buildResources` and explicit macOS/Windows/Linux icon settings use that PNG.
Electron-builder converts it into the platform icon formats; the renderer uses the same E
geometry and Windows/Linux BrowserWindow uses the bundled PNG at runtime.

The updater is an injectable main-process state machine in `src/main/updater.ts`, exposed
through validated IPC and a minimal preload API. Development is a no-op. The automatic-check
preference defaults on, is explained on Welcome/Settings and persists in userData config.
Enabled packaged apps check after 10 seconds and every six hours; a manual check is separate.
Downloads run in the background; installation/restart always requires an explicit user click.
Windows NSIS and Linux AppImage support installation. Current unsigned macOS builds and Linux
`.deb` installations use the latest-release download fallback instead. macOS installation is enabled
only after codesign verification and a Developer ID Application authority check; signing errors also
fall back safely. Opening release/download links is restricted by an explicit GitHub URL allow-list.
The updater's dedicated Electron network partition strips the library's persistent staging-ID
header, cookies and credentials before sending requests, and blocks destinations outside this
repository's GitHub release endpoints and GitHub release-asset CDN paths. State polling in the
renderer uses only local IPC and never checks the network. No telemetry is introduced. The GitHub provider reads public release metadata/assets from
`github.com/kuarezma/ensemble-ai`; GitHub may redirect asset downloads to its release-asset
CDN. This is separate from the existing consented Artificial Analysis refresh traffic.

`electron-builder.yml` fixes the public GitHub provider to `kuarezma/ensemble-ai`. The tag
workflow uses `--publish never`: electron-builder generates update metadata locally, and the
existing release upload step publishes installers, ZIP payloads, `latest.yml`, `latest-mac.yml`,
`latest-linux.yml` and blockmaps together. No builder-side publishing/token flow is needed.

macOS x64 and arm64 are built **in one job and one electron-builder invocation**, with both
DMG and ZIP targets. Artifact names contain the architecture. The builder merges both
architectures' files into one `latest-mac.yml` in that invocation, avoiding competing metadata
from separate jobs overwriting each other. The macOS job verifies both architecture ZIP
names occur in the metadata and both ZIPs exist before upload. ZIP is required by Squirrel.Mac,
even though users normally install the DMG; retaining it also supports a future signed release.
This follows the [electron-builder v26 auto-update requirements](https://www.electron.build/v26/docs/features/auto-update/).
The architecture-selection behavior and merged metadata are also covered by the installed
builder's `publish/updateInfoBuilder` and updater's `MacUpdater` implementations.
Actual installer/update behavior remains unverified until two versions have been published
and tested on the target platforms; macOS signing/notarization is not added in this phase.
