# Changelog

## 2.9.2 — 2026-10-09

- Save the YouTube title and description templates automatically when they are edited (about a second after typing stops, and before leaving the page), per user, and reuse them on the next upload. A status line shows when they were saved; "Restore default" returns to the built-in template.

## 2.9.1 — 2026-10-09

- Fix layout breakage found in a full-site audit at 1920, 1366, 1024, 768, 390 and 360 px: the home page no longer scrolls sideways on phones and the last calendar month label stays inside the card; browse cards hide the date overlay on narrow screens so it does not collide with the duration badge; the admin user list becomes cards on narrow screens so role and actions stay reachable; Ops YouTube rows move their buttons below the title on mid-size screens; storage tiles keep sizes on one line; the editor's in/out fields fit seven digits on phones.
- Stop Chrome from overlaying its cast button on the trip, share and clip players.
- Restore compact close buttons in the editor and dialogs.

## 2.9.0 — 2026-10-09

- Redesign the YouTube upload page: three steps (choose videos, title and privacy, confirm) instead of five. Linking the channel is no longer a step — it appears as a separate screen only when no channel is linked or when reauthorizing; once linked, the page header just shows the channel.
- Use the full desktop width for choosing trips: a date list on the left, thumbnail cards with per-camera toggles in the middle, and the selection with an upload-schedule estimate on the right. Tablet and phone layouts collapse the dates into a scrolling strip and the selection into an expandable bar.
- Spread uploads evenly across the day: with a daily limit of N, each new upload starts at least 24h/N after the previous one instead of the whole allowance running back to back. Ops › YouTube › Channel can switch to "as fast as the limit allows". The queue shows each video's estimated start time, and the confirm step draws the first day's schedule on a 24-hour ruler.
- Offer two choices for videos that were deleted on YouTube: re-upload, or dismiss (stop reminding; the trip can still be chosen again later), per video or all at once.
- Record the resolution YouTube received and its HD status; a 1080p upload is only marked complete (and eligible for local cleanup) once YouTube has finished the HD version. Uploads continue to send the original file without re-encoding.
- Cancelling the last active upload of a trip now drops its pending playlist pairing instead of leaving it to fail later.
- Remove emoji and decorative symbols from the interface (status labels, buttons, link markers and the YouTube playlist cross-link text).
- Show a public app introduction to visitors while retaining the trip dashboard for signed-in users. Link the privacy policy and terms from the introduction and login page.
- Expand the privacy policy with account, footage, OAuth and YouTube API data collection, usage, recipients, retention, security and deletion disclosures; add separate service terms and a deployment-configured public contact address. Keep the previous YouTube privacy URL working.
- Keep the public contact address readable without JavaScript when served through Cloudflare email protection.
- Update the compatible brace-expansion dependency to 5.0.12 to address the release audit's high-severity recursion vulnerability.

## 2.8.0 — 2026-10-07

- Sync uploaded videos with YouTube from Ops: read back each video's current title, privacy, views, likes and comments, and flag videos that were deleted on YouTube. Syncing runs when the archive opens (at most every five minutes) or on demand, and never changes anything on YouTube; each video links to YouTube Studio for edits and deletion.
- A video deleted on YouTube becomes re-uploadable: choosing its trip again in the wizard re-queues only the missing camera.
- Grey out trips in the upload wizard whose cameras are all uploaded or in progress; "select page" skips them.
- Show the Ops storage summary in the same card style as the admin storage panel.

## 2.7.0 — 2026-10-07

- Turn the YouTube page into a five-step upload wizard (connect channel, choose trips, title and description with live preview, upload mode, confirm). An unconfigured site now explains why the channel cannot be linked and takes the owner straight to the setup steps instead of showing a disabled button.
- Move YouTube management to Ops: a step-by-step Google Cloud OAuth guide with copyable redirect URI, channel pause/limit/disconnect, upload progress with per-step history, and the archive with local cleanup.
- Pair front and rear camera uploads: once both are processed, create one playlist per trip and cross-link the two videos in their descriptions. Each step is resumable and retried with backoff. The OAuth scope adds `youtube.force-ssl` for playlists and description updates.
- Add an Ops storage pane that shows disk usage and lists space held by superseded source trips and interrupted merges, with verified, confirmed deletion.
- Merge each trip into a hidden `.partial-*` folder and rename it only on success; leftovers from an interrupted service are removed at startup instead of becoming orphan trip folders.
- Make inline links and secondary/danger buttons visibly clickable across all pages, and show disabled buttons clearly.

## 2.6.0 — 2026-10-06

- Add a fixed-layout YouTube workspace with cross-page trip selection, paired front/rear uploads, editable metadata templates, preview, privacy and audience controls, and scheduled start times.
- Link each user’s own channel through OAuth with PKCE, single-use session-bound state, and encrypted offline credentials. Site owners configure the OAuth application without publishing secrets.
- Persist resumable uploads, daily channel/project budgets, quota delays, pause/cancel/retry actions, processing checks and paginated operation history.
- Add original local downloads and official Studio/Takeout export links. Local cleanup requires explicit confirmation, successful processing of all existing cameras, matching versions and a recoverable filesystem journal. Preserve footage during tests.
- Document that YouTube is a transcoded secondary copy without guaranteed permanent retention or original-quality downloads.

## 2.5.0 — 2026-10-02

- Rework the trip player controls after YouTube: a thin full-width progress bar along the bottom of the video that thickens on hover with a red scrubber, buffered range and a time preview; one row of plain white icons with hover tooltips (play, frame step, volume with an expanding slider, elapsed / total time with the dashcam's actual clock, camera switch, snapshot, settings and fullscreen).
- Add a settings menu with a playback speed panel (0.25–4×) and a picture-in-picture switch; add J / K / L keyboard shortcuts.
- Open the trip note editor as a floating card so editing no longer reflows the page or leaves blank gaps.
- The ambient-light player from 2.4.0 was withdrawn.

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
