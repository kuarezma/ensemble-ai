# Contributing

Use Node 22.12+ and keep changes scoped to the current phase. Read docs/SPEC.md first.
Run `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` before delivery.
Use `npm run format` for formatting. Never commit secrets, machine-specific paths or generated caches.

Core code must remain independent of Electron/DOM. Every file writer receives an explicit root;
tests create and clean disposable directories with os.tmpdir(). Never test writes against a real HOME.
Protect managed-block boundaries, preview conflict detection, backup/manifest recovery and revert.
Catalog changes require source attribution; preserve unknown values and honest verified flags.
UI, i18n, real-client integration, release CI and installer acceptance belong to Phase B or later.
