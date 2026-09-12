# Changelog

## 2.1.0 — 2026-09-12

Seven sequential implementation stages focus on open-source self-hosting.

- Recoverable editing: journaled media replacement, fractional offsets, immutable clip source
  timestamps, gap-aware camera timelines and verified output duration.
- Owner-scoped background history, bounded queues, cancellation and explicit interrupted-job retry.
- Resumable 4 MiB uploads with persisted manifests, optional chunk SHA-256, disk reservations and
  automatic complete-batch handoff. Transfers still require an open browser until server acceptance.
- Mobile and keyboard editing, local drafts, timeline zoom and three shared semantic palettes.
- Generic MP4/MOV/TS naming, rear-only recordings, content-based duplicate detection, clip search,
  pagination, rename and report drafts.
- Non-root Compose deployment, diagnostics, offline verified full-data backups and restore refusal
  on existing or relocated destinations.
- Integration hardening: stale-edit rejection, camera stream compatibility, collision-safe output
  directories, bounded probe/log resources, process shutdown and rejected-file preservation.
- Removed duplicate theme bootstraps, obsolete stylesheet helpers and unused job cancellation APIs;
  shared browser timeline mapping and enabled unused TypeScript symbol checks.
- CI covers build, formatting, unit/integration tests, browser workflows and a Compose health check.
- Updated Fastify and fast-uri; production dependency audit reports no known vulnerabilities at
  verification time. Related upstream advisories:
  [Fastify](https://github.com/advisories/GHSA-w2qp-rph6-63g4) and
  [fast-uri](https://github.com/advisories/GHSA-5jgf-p345-68v8).

### Upgrade notes

Stop the service and make a full-data backup before upgrading. Explicitly preserve your existing
`DASHCAM_DATA_DIR`: the native default changed from `/mnt/data/dashcam` to project-local `data/`.
New database columns migrate automatically; rollback requires the matching pre-upgrade backup.
Legacy clips without immutable capture timestamps need manual verification. Existing custom UI
strings remain operator-owned. See [operations](docs/OPERATIONS.md) for concurrency setting changes.

One service process and local storage are required. Server restart marks unfinished work interrupted;
it does not resume an encoder at the previous frame. Automatic codec conversion, arbitrary camera
filename guessing, distributed queues and backup path relocation remain outside this release.
