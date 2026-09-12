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
4. Editor experience and shared theme system — pending.
5. Device compatibility and personal media management — pending.
6. Self-hosted installation, diagnostics, backup and recovery — pending.
7. Integration verification, cleanup and release documentation — pending.

The remote repository originally lacked clips, devices and shares. Stage 1 integrates the audited
local application baseline, retains upstream history/license, then adds regression fixes.
Each stage records tests, migration implications and limitations here and in README.
