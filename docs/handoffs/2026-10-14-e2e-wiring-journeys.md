# Handoff: e2e wiring journeys

Written 2026-10-14. Branch `architecture-redesign`. Nothing from this session is committed.

## What this session did

- Merged `origin/main` into the branch as `987665c`. Two conflicts, both in the Monaco files under `packages/ui/src/kit/code/`. Resolved by keeping the new paths and main's `APP_FONT` to `CODE_FONT` rename.
- Designed and built a new test layer so a green run can replace the manual click-through before a release. The design, the spike result, the decisions that changed during the work and the execution model are in `docs/e2e-test-strategy.md`. Read that first.
- Fixed the password prompt for saved connections that fail with `AUTH_FAILED`. A new `ConnectionPasswordDialog` tests the typed credentials, then saves them on the profile and connects. Its journey is `e2e/wiring/journeys/standalone/secured-connect.spec.ts`.
- Added a `plan-work` skill at `~/.claude/skills/plan-work/SKILL.md`. It is not yet synced to the config repo.

## Current state

Everything is in the working tree. Run `git status` for the list. In short:

- New: `e2e/wiring/` (server, bridge, fixtures, 46 journeys in three segments), `e2e/infra/` (Compose stacks), `e2e/coverage-map.ts`, `e2e/coverage-check.ts`, `tests/coverage-*.test.ts`, `packages/app/src/main/dialog-picks.ts`, the connection password dialog and store in `packages/ui/src/connections/`, `docs/e2e-test-strategy.md`.
- Changed: `.github/workflows/ci.yml`, `e2e/global-setup.ts`, `e2e/support/app.ts`, `e2e/support/mongo.ts`, `package.json`, `tsconfig.tooling.json`, `packages/app/src/main/index.ts`, `packages/app/src/main/rpc/router.ts` and its test, `packages/ui/src/state/app-store.ts` and its test, `ShellScreen.tsx`, `connections/index.ts`.

Last verified run, all green:

- Wiring: standalone 39 of 39, replica set 6 of 6, docker 1 of 1.
- Coverage check passes on the traces from all three segments. 59 methods are mapped to a journey out of about 190.
- Typecheck passes. Lint has 0 errors. Unit tests pass except `packages/ui/src/editor/language-tokens.test.ts`, which times out under full-suite load and passes alone.
- `format:check` fails only on `docs/architecture-redesign.md` and `packages/ui/src/profiler/ProfilerPanel.test.tsx`, which failed before this work.

Not verified: the CI jobs on GitHub (artifacts, Chrome on the runner, image pulls, the mongo-tools cache).

## How to run

- Build once: `pnpm build`. Then set `E2E_PREBUILT=1` to skip the build.
- Segments: `pnpm test:wiring`, `E2E_SEGMENT=replset pnpm test:wiring`, `E2E_SEGMENT=docker pnpm test:wiring`.
- Coverage: set `MONGO_GUI_RPC_TRACE=<abs dir>/<segment>.jsonl` for each run, then `node e2e/coverage-check.ts <dir>`.
- Backup and restore need `pnpm --filter @mongo-gui/app fetch:mongo-tools`.
- Run one Playwright session at a time on this machine. Agents used `flock /tmp/mongo-gui-wiring.lock`.

## Open decisions

1. Commit policy. The memory note says commit on main. The work sits on `architecture-redesign`. Decide where it lands and how to split the commits.
2. `packages/mongo-adapter/src/client-options.ts` overrides a `serverSelectionTimeoutMS` set in the URI with its 10 s default. Found by a journey, not fixed.
3. The profiler detail pane has no role or label, so its test finds it through an XPath sibling of the resize separator. An aria-label in `ProfilerDetail.tsx` would fix it. That is a production edit.
4. The editor still calls `databases.list` after a disconnect (`EditorView.tsx` lines 129 to 135), which logs NOT_CONNECTED.
5. `connections.status` is not in any trace, so it is still `excluded` in the coverage map.
6. The Backup and Restore dialogs wait up to 30 s on the tools feed when the network is blocked.
7. The password dialog saves the password on the profile once the server accepts it. Change this if the user wants it kept for the session only.
8. Making the wiring jobs required in CI. The plan says to run each segment non-blocking for about two weeks first.

## Not covered by journeys, and why

Step down, initiate, add or remove member and `killAllSessionsByUser` are skipped because they would destabilize the shared replica set or kill the app's own sessions. The master password and vault screens belong to the Electron layer, which has three older specs in `e2e/tests/` on testcontainers.

## Gotchas for the next agent

- A coordinator agent hands back early when its context fills. Keep tasks short and ask for one status line per task.
- Validators break a UI call on purpose, rebuild and restore. A script can outlive its agent and keep mutating files under the lock. Wait for the lock, then check `git diff` on the touched file before you run anything.
- Validators left scratch specs named `zz-val-*` and `tmp-probe*` once. They are deleted now. Check for new ones.
- The router now logs unknown methods and rejected input or output. `ERROR_LINE` in `e2e/support/app.ts` matches those, so an Electron test fails on them.
- `docs/screenshots` must hold exactly the four pinned files. Test images go to `e2e/output`.

## Next steps

1. Review the working tree and commit it by the policy in decision 1.
2. Resolve decisions 2 to 4.
3. Push to a branch and watch the CI wiring jobs. Fix what only fails on the runner.
4. Add journeys for the common paths still unmapped, starting with the editor and results views, indexes, import and export, and transfers. Use the coverage map as the list.
5. Run the segments non-blocking for about two weeks, then make them required.
6. Waves 2 and 3 of `docs/architecture-redesign.md` are still open.

## Suggested skills

- `plan-work` to plan the next batch of journeys or waves 2 and 3. It calls `grilling` for the decisions.
- `run-app` for launching the Electron app or the browser mock UI.
- `my-review` or `my-code-review` before committing the working tree.
- `resolving-merge-conflicts` if `origin/main` moves again.
- `pr` when writing the pull request body.
