# Changelog

## 2.4.0 — 2026-10-02

- Add ambient light to the trip player: the video casts a soft glow in its own colours, sampled only on new frames into a tiny canvas with frame blending, GPU blur and a fading mask. The approach is adapted from youtube-ambilight (MIT, Wessel Kroos); it can be turned off from the player and the choice is remembered.
- Move the player controls out of the picture into an open bar below the video, keep the video frame at 16:9 instead of letterboxing, and keep the bar on one line at common widths. Fullscreen includes the controls as an auto-hiding overlay.
- Open the trip note editor as a floating card so editing no longer reflows the page, shrinks the video or leaves blank gaps.
- Move keyboard shortcut hints into a help button in the player.

## 2.3.0 — 2026-10-02

- Keep the trip viewer on one screen on desktop: the page no longer scrolls or rubber-bands, and other trips of the day sit in a single horizontal row.
- Redesign the player controls as a floating dock: a prominent play key between 10-second jumps, the dashcam's actual clock (click to switch to elapsed time), a separate frame-step island, and a tools island with camera switch, a 0.5–4× speed menu, picture-in-picture toggle, snapshot, mute with a slide-out volume and fullscreen. The progress bar thickens on hover, shows buffered video and previews the actual time.
- Fix the trip note editor: Cancel now closes it (the click no longer reopens the editor), Esc cancels and Ctrl/⌘+Enter saves.
- Make the Time Machine faster: render only the windows near the current date, stop reading layout during animation, drop per-frame repaints and load thumbnails only for the front windows.
- Restyle Time Machine windows after current macOS: larger corners, unified toolbar with a date heading and summary pill, and an inset content panel.
- Remove nested scrolling in Time Machine windows: a 24-hour ribbon shows each trip of the day, and the tile grid sizes itself to fit every trip; days that cannot fit end with a "+N trips" tile.

## 2.2.1 — 2026-10-02

- Fit the home overview to the window height instead of a fixed 16:9 image, so nothing is cut off on 1366×768, 1280×720/800 or other short screens; narrow or very short windows scroll normally.
- Balance the two home columns: the latest trip fills the main column (kept landscape, with a compact fact strip on tall screens) and recent trips move into the side list, showing only rows that fit fully.
- Fold secondary home blocks in order (this month, quick-action captions) when space is short, and scale the riding calendar to its panel.
- Widen the shared content column on large monitors (1400px from 1680px wide, 1640px from 2200px).

## 2.2.0 — 2026-10-02

- Replace the rotating home slogans with a one-screen overview: a data-driven headline (today / yesterday / days since the last ride), the latest trip as a large feature, recent trips, a compact riding calendar with longest streak, this month's totals and quick actions.
- Keep Browse on one screen on desktop and phones; only the date list and the day's trips scroll, and the footer is hidden. Phones get a horizontally draggable date strip.
- Rebuild the date gallery as a macOS Time Machine-style view: dated windows recede into a starfield, a spring-driven stack follows trackpad, drag, arrows and keyboard, and a magnifying timeline jumps to any date.
- Give exported clip cards a single action row (download, edit again, report, and a menu for rename / open source / delete).
- Copy SFTP server, user, password and FileZilla command by clicking the field itself.
- Turn Admin, Ops and Account into single-screen consoles with side tabs instead of long scrolling pages.
- Make the database viewer readable for non-specialists: plain-language table and column names, formatted times, sizes, durations and JSON, a details drawer, and a raw-column mode.
- Summarize background job logs into phases, key figures and a per-trip merge table instead of repeating every progress line; the upload page uses the same live view. The jobs page becomes a list with a detail panel.

## 2.1.7 — 2026-09-28

- Keep the home calendar inside its own horizontal scroller on narrow phones instead of widening the whole page.
- Reflow the trip heading and metadata for narrow screens so dates, times and device names remain readable.
- Fit exported clip cards within phone widths and keep administrator table actions on one line.
- Shorten upload guidance and place supported filename formats in an expandable section.
- Add browser regression coverage for 320px layouts and text wrapping.
- Add twelve short, more personal home slogans, avoid showing the same one after a reload, and offset their supporting line on desktop.
- Add a Browse date gallery with a blurred gray backdrop, animated horizontal depth cards, trackpad/drag/keyboard navigation, and selectable trip previews.

## 2.1.6 — 2026-09-28

- Style the clips search field with palette-aware form tokens and make its toolbar usable on narrow screens.
- Link exported clips back to the source trip editor with their saved range and export options preselected, without changing the existing clip.
- Show Load more only when an additional page exists; keep it hidden for a short result list.
- Show hours in player and editor timecodes once the recording reaches one hour, including the current time, and keep trip, clip and shared playback consistent.

## 2.1.5 — 2026-09-27

- Resume synchronized playback after both cameras buffer two seconds, and request another range when a paused browser stops preloading before that threshold.
- Keep the source trips and their media after combining trips; hide superseded sources from normal lists, day counts and statistics while preserving their direct links and database records.
- Keep retained source files visible in the administrator file inventory and label them as merged sources so disk usage remains accurate.
- Preserve the source-to-combined relationship in trip metadata so a database rebuild restores the same visible trips. Restore source visibility if a combined trip is deleted.

## 2.1.4 — 2026-09-27

- Save background processing steps and counts, with a responsive job timeline and owner-only history API.
- Limit each account to one active upload session and simplify the upload page after a session is created.

## 2.1.3 — 2026-09-27

- Wait for three seconds of buffered footage on both cameras before starting or resuming
  synchronized playback. Scale the refill target with playback speed, while allowing an
  already playing stream to continue until it actually runs short. Delay the buffering
  message briefly so momentary waits do not flash over the video.
- Round trip durations to whole seconds for display, avoiding floating point tails.
- Move the MP4 index to the front of newly merged videos for faster starts and seeks
  on slow connections. Existing media is unchanged.
- Version the player and shared page script URLs so browsers fetch these fixes after deployment.

## 2.1.2 — 2026-09-13

- Keep the shared header transparent before and after scrolling, with backdrop blur and
  palette-aware navigation/account text instead of the opaque dark bar.
- Unify form fields, editor time/zoom controls, segmented options and file-picker buttons with
  tinted semantic colors. Preserve native select arrows, keyboard focus, disabled states and
  the scoped dark login form.
- Add desktop/mobile browser regressions for all palettes, transparent scrolling headers,
  usable editing controls and login readability.
- Version the shared theme stylesheet URL on every page so cached styles do not mask deployment.

## 2.1.1 — 2026-09-13

- Coordinate front/rear buffering through one shared playback controller across trip viewing,
  editor preview and anonymous sharing. Both cameras wait when required footage buffers, then
  resume together. Manual pause remains authoritative while the network recovers.
- Show which camera is buffering; exclude missing footage and already-ended companion streams
  from the wait barrier. Camera swaps preserve capture time across unequal camera timelines.
- Stop chasing a moving playback clock while a camera seeks, surface playback failures instead
  of swallowing them, and clean up listeners/pending playback when a shared player is replaced.
- Add deterministic playback-state regressions and real delayed-media-response browser tests.
  Remove the superseded seek-only synchronizer and document the maintainer's commit/push/deploy
  completion requirement in AGENTS.md.

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
