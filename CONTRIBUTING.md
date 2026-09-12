# Contributing

Use Node.js 22+ and FFmpeg/FFprobe. Keep one service process per data directory.
Tests create synthetic fixtures in temporary directories; never point tests at live media.

Before submitting: `npm run build`, `npm test`, `npm run test:ui`, and `git diff --check`.
TypeScript rejects unused variables/parameters. New core modules use Prettier (100 columns).
Format changed modules, not unrelated legacy pages: `npx prettier --write <changed-file>`.

Keep filename parsing, timeline mapping, media commit/recovery and job orchestration in their
shared modules. Route handlers enforce authentication/ownership before returning sensitive data.
Never publish `SELECT *` rows directly: maintain explicit public DTOs and their contract tests.
Do not equate a completed child FFmpeg step with a completed import batch.

Every storage change needs a failure/restart test, not just a happy path. New device parsers need
real-date validation, front/rear pairing, rear-only coverage and documented naming examples.
Theme variants use semantic variables in `static/themes.css`; do not copy component styles per theme.

Use focused Conventional Commit messages (`fix(media): ...`, `feat(upload): ...`, `test: ...`).
Include migration/rollback notes when database or persisted-file formats change.
