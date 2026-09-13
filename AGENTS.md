# Project working agreement

- For this maintainer's approved implementation work, completion means: implement, test, make a
  focused commit, push, deploy to the existing website, and verify the actual public page after a
  browser reload. A GitHub push alone is not a deployment. Report the deployed commit and checks.
- Inspect the current service configuration and preserve its real data path and existing settings.
  Use an isolated release directory, retain the previous program, check active jobs before stopping
  the service, and keep a rollback record. Do not deploy untested changes or hide failed CI checks.
- The maintainer currently requests program/configuration/database backups without copying the
  large video collection. Preserve original videos; never describe this as a full media backup.
  A new operation that would destroy or overwrite original footage requires separate approval.
- Do not expose credentials, tunnel tokens, session cookies or private deployment data in commits
  or logs. Keep machine-specific paths and rollback archives outside the public repository.
- Read-only questions/reviews do not authorize modifications or deployment. If access, data safety
  or a required user decision blocks deployment, explain the blocker rather than claim completion.
- Keep playback coordination shared between trip viewing, editing preview and anonymous sharing.
  Add regression coverage for network waiting, manual pause, camera gaps, seeking and cleanup.
