# Implementation ledger

Seven ordered releases, one commit per stage. No production database or media is used in tests.

1. Editing safety and source time correctness — implemented. Journaled file rollback, precise offsets,
   immutable clip selection timestamps, output probing, camera timelines and gap-aware playback.
   Validation: baseline 144 cases plus 4 media safety regressions; updated the explicit DTO contract
   for the public timeline field. Legacy clips without source timestamps require manual verification.
2. Persistent background work and job center — implemented: SQLite history, global/per-owner queue,
   cancellation, safe retry routing, duplicate export suppression, restart interruption status and
   finalization-aware results. Tests cover queue admission, finalization, history isolation and restart.
3. Resumable uploads and server handoff — implemented: persisted file manifests, positional chunks,
   checksum validation, complete-batch confirmation, automatic handoff, 24-hour resume grace and
   disk reservation for editing. Tests verify byte identity after resume, wrong offsets, mismatched
   file identity, checksum rejection and incomplete-batch rejection. Browsers must remain open until
   transfer finishes; restart may require reselecting files, never a promise of closed-browser upload.
4. Editor experience and shared theme system — implemented: fractional numeric selection,
   keyboard-accessible handles, zoomable timeline, version/camera-scoped local drafts, camera
   source switching, reconnecting export progress and mobile editor access. Shared semantic
   palettes (harbor/terracotta/slate) replace binary theme switching; no remote font dependency.
   Browser regressions exercise mobile editing, draft recovery and every palette.
5. Device compatibility and personal media management — implemented: explicit generic interchange
   filenames (MP4/MOV/TS), rear-only scanning for all profiles, safe stream compatibility checks,
   measured frame-rate stepping, SHA-256 duplicate identity, paged/searchable clips, rename and
   paged daily journeys. Unknown filenames are rejected; arbitrary camera metadata guessing and
   automatic incompatible-codec transcoding are intentionally not enabled. 26 scoped tests pass.
6. Self-hosted installation, diagnostics, backup and recovery — implemented: non-root Docker/
   Compose configuration, native environment loading, safe local defaults, public minimal health,
   admin/CLI diagnostics, offline full-data bundles with SHA-256 and SQLite verification, restore
   that refuses overwrite or path relocation, and deployment/upgrade/recovery documentation.
   Native build and bundle round-trip tests run locally; Docker is unavailable in this workspace,
   so container execution remains a CI/deployer verification item, not a claimed local result.
7. Integration verification, cleanup and release documentation — implemented. Fixed stale edit
   retries, cancelling before expensive copies, incomplete terminal events, legacy trim offsets,
   output directory collisions, rejected-upload preservation and mobile box sizing. Shared camera
   mapping now serves both authenticated and anonymous players; removed duplicate theme bootstrap
   code and unused helpers/job APIs. Bounded metadata probes and encoder logs, stopped owned media
   processes during shutdown, enabled unused-symbol checks and added focused formatting checks.
   Release 2.1.0 includes CI, a changelog and contributing guidance. Native build/format checks and
   all 163 unit/integration tests pass. Production dependency audit reports zero known findings.
   All five local single-page browser regressions pass, covering mobile layout, editing/drafts,
   palettes and closing
   an accepted export page before downloading its completed output. Multi-page share tests timed
   out under severe memory pressure on this shared 2 GB host; full verification and Docker startup run in the
   [Verify workflow](https://github.com/Zhuyuan0907/Dashcam-Viewer/actions/workflows/verify.yml).
   Check that workflow's result for the exact commit before deploying; local browser timeouts are
   not counted as passes, and no live deployment or real media was modified.

The remote repository originally lacked clips, devices and shares. Stage 1 integrates the audited
local application baseline, retains upstream history/license, then adds regression fixes.
Each stage records tests, migration implications and limitations here and in README.
