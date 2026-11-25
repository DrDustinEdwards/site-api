# CLAUDE.md - site-api

The standard site API every Dustin Edwards site includes so Carrel can list, edit and publish its content (`@dustinedwards/site-api`). No keys or content live here. `README.md` is the reference.

## Rules every repo shares

- **Tests.** Reproduce a reported failure before fixing it, and report red before and green after. Keep the minimal set: a few browser tests for flows that must never break, one integration test per real behavior, unit tests only for tricky logic, shared code tested once where it lives. Remove a test that pins design, repeats coverage or never caught a mistake, unless it guards a harm that cannot be undone.
- **Shared code.** Before writing anything another site might have, check https://github.com/DrDustinEdwards/devkit/blob/shared-list/SHARED.md. Change shared code in place and delete what the change replaces in the same PR.
- **Secrets.** Never commit or print a key, token, `.dev.vars` or `.env`.
- **Releases.** A PR adds a changeset (`npx changeset`, `--empty` when nothing ships) and never edits the version or CHANGELOG.md. A release is its own PR running `npx changeset version` on main; merging it publishes. Nobody tags by hand; consumers pin a tag (Dustin, 2026-11-13).
