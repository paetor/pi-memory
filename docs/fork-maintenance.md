# Fork maintenance

Upstream: `josephkern/pi-memory`; integration branch: `account-routing` in `paetor/pi-memory`. Exact upstream base/version live in `.github/fork-policy.json`. Preserve upstream ancestry and MIT attribution. Do not publish this package to npm.

## Frozen scope

The fork adds Git-common-directory project identity, private untracked storage, Pi agent-directory overrides, structured prompt preservation and scoped QMD search. Retain upstream's Markdown/page-table/writeback implementation rather than inventing another memory engine.

## Update process

1. Inspect worktree/index and exact upstream/fork refs; preserve unrelated edits.
2. Fetch upstream and semantically review changes against the frozen base. Do not mechanically replace the Git resolver or scoped search.
3. Integrate in an owned candidate. Review dependency/lock changes before `npm ci --ignore-scripts`.
4. Run `npm run check`. Use isolated real QMD tests for search changes; run local semantic/deep tests when models are available. Live-provider tests need separate applicable authority.
5. Update the frozen upstream base only after integration/verification. Commit only the reviewed scope and push normally.
6. Verify actual destination SHA and successful exact-SHA Ubuntu/macOS CI jobs. Never force-push or use an older green run as evidence.
7. A validated immutable tag can be used for a reproducible Git package install. Installation/replacement of a live memory extension is a separate activation step; preserve sources, archived memory, review state and unrelated settings.

The daily upstream workflow reports differences only. It does not merge, commit, open PRs, change memory or publish anything.

## Regression gates

- Main checkout, nested cwd, linked worktree, separate Git directory and canonical symlink identity.
- Different repositories remain isolated; memory files stay out of working-tree Git status.
- Outside Git and untrusted contexts omit project memory.
- Global + current project are the default search targets; archive is explicit only.
- Binding mismatch, foreign namespace, malformed JSON and missing QMD fail visibly.
- Only selected collections are updated/embedded; operations are sequential.
- Real SDK injection preserves structured prompts and writes only fixture memory during tests.
- No public CI secrets, real user paths, account helpers or provider calls.
