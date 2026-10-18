# Green CI, then release 0.4.0

## Goal and done check

- CI workflow is green on `main` for 3 runs in a row at the same commit.
- Tag `v0.4.0` is pushed and the Release workflow publishes the GitHub release (draft turned public, installers for all three OS).
- Check: `gh run list --workflow CI --branch main --limit 3` shows three `success` on one head SHA, and `gh release view v0.4.0 --json isDraft,assets` shows `isDraft: false` with assets.

## Constraints and do-not-change

- Work on `main`, as the recent CI runs do. Commit only the files a task names, with `git add <path>`.
- Do not touch the owner's uncommitted work: `packages/ui/src/connections/ConnectionTree.tsx`, `docs/ui-guidelines.md`, `.idea/`, `docs/plans/2026-10-17-copy-sync.design.md`. Do not edit any file while a `TODO-AI` review is open (`grep -rn "TODO-AI"` first; if hits exist, stop and ask).
- No `Co-Authored-By`, no tool attribution, no trailers in commits (global CLAUDE.md wins over the harness reminder).
- Do not weaken tests to get green: no skips, no raised timeouts, no loosened assertions without a stated cause.
- `packages/app/package.json` stays at `0.4.0`; `CHANGELOG.md` already has the 0.4.0 entry. Release tag must equal `v` + that version.
- No screenshot changes (`docs/screenshots` is pinned).

## Baseline (before any change)

Latest runs on `main`:

- Run 39066476187 (merge of feat/diagnostics-design): `check` failed on all three OS. `coverage` failed. `build`, `e2e`, `platform`, `wiring`, `integration` skipped because `check` failed.
- Run 39060768635 (release commit): only `integration (app)` failed.
- Run 39067601053 (a5d13ae) was in progress at planning time. Task T0 records its result.

Known causes:

| Failure | Cause | Class |
| --- | --- | --- |
| `Check formatting` on windows and macos | `packages/ui/src/diagnostics/LogsTab.tsx` fails `prettier --check` | code |
| `Unit tests` on ubuntu | 6867 pass, then `Vitest caught 1 unhandled error: ReferenceError: window is not defined`, from a Mantine Transition timer firing after jsdom teardown, traced to `packages/ui/src/screens/UnlockScreen.test.tsx` | test bug |
| `integration (app)` | `backup.integration.test.ts` pulls `mongo:4.4` on demand, Docker Hub answers `toomanyrequests`. `afterAll` (line ~181) then throws on `events` undefined and hides the real error. The CI pre-pull step only has `mongo:8.0.17` | infra plus test bug |
| `coverage` | `Check RPC coverage`: `ENOENT scandir e2e/output/traces`. Cascade from skipped `wiring`. Not a bug | cascade |

Local checks: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm exec vitest run --project unit`. Known intermittent Vitest native crash (SIGSEGV) is not app code, see memory `project-mongo-gui-vitest-worker-crash`.

## Pattern to copy

Past fix of the same kind: commits `test(e2e): allow two harmless Chromium start-up messages` and `test(e2e): scroll the ag-grid 36 vertical viewport...` (green runs 39058400509 and 38358773127). Small test-only commits, one cause each.

## Tasks

| Id | Model | May edit | Reads | Waits for | Check |
| --- | --- | --- | --- | --- | --- |
| T0 | Haiku discover | none | CI run 39067601053 via `gh`; `docs/plans/2026-10-17-dedupe.cpd-baseline.md` | none | Report: conclusion and failing step per job of run 39067601053, plus the CPD cluster list for `packages/ui` and `packages/app` saved to `docs/plans/2026-10-17-green-ci.cpd-baseline.md` |
| T1 | Haiku | `packages/ui/src/diagnostics/LogsTab.tsx` | same file | T0 | `pnpm exec prettier --check packages/ui/src/diagnostics/LogsTab.tsx` exits 0 and `git diff --stat` shows whitespace-only change. Run `prettier --write` on that one file |
| T2 | Haiku | `packages/ui/src/screens/UnlockScreen.test.tsx` | same file, a sibling test that uses Mantine transitions, `packages/ui` vitest setup file | T0 | `pnpm exec vitest run --project unit packages/ui/src/screens/UnlockScreen.test.tsx` passes 10 times in a row, and `pnpm exec vitest run --project unit packages/ui` prints no "unhandled error". Fix is cleanup in the test: await the transition, `unmount()` and flush timers (`vi.runOnlyPendingTimers()` under fake timers) in `afterEach`. Do not edit the component |
| T3 | Haiku | `packages/app/src/**/backup.integration.test.ts` (find with `git ls-files '*backup.integration.test.ts'`), `.github/workflows/ci.yml` | the test file lines 1-60 and 160-200, ci.yml integration job | T0 | In the test, `afterAll` returns early when `events` is undefined, so the original error shows. In ci.yml, the pre-pull step for the `app` matrix entry also pulls `mongo:4.4`. Check: `pnpm exec prettier --check` on both files, `pnpm typecheck`, `pnpm lint`, and `grep -n "mongo:4.4" .github/workflows/ci.yml` shows the pull |
| T4 | Sonnet coordinator | none | | T1, T2, T3 validated | Local gate: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm exec vitest run --project unit` all exit 0. Then commit the three fixes as separate commits and `git push origin main` |
| T5 | Sonnet coordinator | none | | T4 | Run 1 of 3: `gh run watch` the CI run for the pushed SHA, all jobs `success`. If any job fails, go to the failure loop below |
| T6 | Sonnet coordinator | none | | T5 | Runs 2 and 3: `gh run rerun <id>` on the same SHA, twice, one at a time. Both must end `success`. A failure in a rerun counts as a flake: go to the failure loop |
| T7 | Sonnet coordinator | none | | T6 | Release: confirm `grep '"version"' packages/app/package.json` is `0.4.0` and `HEAD` equals the SHA that had three green runs. `git tag v0.4.0 <sha>` and `git push origin v0.4.0`. `gh run watch` the Release workflow. Check: `gh release view v0.4.0 --json isDraft,assets` shows `isDraft: false` and installers for linux, windows and macOS |
| T8 | Haiku | `docs/plans/2026-10-17-green-ci-release-0.4.0.status.md` only | CPD output | T7 | Finishing validation below |

T1, T2 and T3 touch different files and run together. T3 owns `ci.yml` for the whole plan.

## Failure loop (T5 and T6)

1. A Haiku discover agent reads `gh run view <id> --log-failed | tail -80` for each failed job and returns the failing step, the first error lines and a class: code bug, test bug, flake or infra.
2. Code bug or test bug: the coordinator hands the log excerpt and the suspect file to a new Haiku implementer with a one-cause brief. An Opus validator reruns the check and reads the diff. Then commit, push, and restart the count at run 1.
3. Infra (rate limit, runner outage) with no repo fix: rerun once. Two infra failures on the same step means add a repo-side mitigation (pre-pull, retry) as a new task.
4. Same job fails twice with an unclear cause: stop and report to the user. No more than 3 fix rounds in total.
5. `coverage` failing with `ENOENT e2e/output/traces` while `wiring` was skipped is a cascade, not a task. If it persists after `wiring` runs, treat it as a code bug in `Check RPC coverage`.

## Phases

1. T0
2. T1, T2, T3 (parallel, 3 agents, within the agent limit)
3. T4, T5, T6, T7 (serial, coordinator)
4. T8

## Serial resources

- CI runs on `main`: one at a time. The coordinator alone pushes and reruns. Implementers never push.
- Before every push, cancel in-progress CI runs on `main` (`gh run list --workflow CI --status in_progress --json databaseId -q '.[].databaseId' | xargs -r -n1 gh run cancel`). Owner instruction on 2026-10-17. The owner pushed another commit after planning, so run `git pull --rebase origin main` first and treat the new head as the baseline.
- Docker and Electron or Playwright: T1 to T3 need neither. If a failure-loop fix needs e2e locally, only one such run at a time, and remove exited containers afterwards (memory `feedback-agent-limits`).
- Git working tree: shared with the owner's uncommitted files. Implementers `git add` only their own paths.

## Finishing validation

T8 runs the `cpd-duplication` skill on `packages/ui` and `packages/app` and compares with the baseline from T0. It reports new clusters and clusters that grew, with files, line ranges and a proposed fix. It does not refactor. The coordinator lists them in the status file and the user decides.

## Rework rule

A failed validation goes back to the same implementer with the failing output, at most two rounds, then the coordinator rewrites the brief. Status file: one line per task in `docs/plans/2026-10-17-green-ci-release-0.4.0.status.md`.

## Commit policy

- One commit per cause: `style(ui): format LogsTab`, `test(ui): flush Mantine transition timers in UnlockScreen test`, `test(app): guard backup afterAll and pre-pull mongo:4.4`. No trailers.
- Reviewer: the owner reads the commits after the release. The Opus validator reviews each diff before the push.

## Risks and open decisions

- The tag push is outward-facing and publishes installers. Approving this plan counts as approval for T7. Say so if you want a pause before the tag.
- Three green runs come from one push plus two reruns of the same SHA. That catches flakes but is not three separate commits. Say so if you want three pushes.
- The ubuntu unhandled-error may be a race that shows only sometimes. T2 checks 10 repeats, but CI may still expose a second leaked timer in another test file.
- Windows and macOS `e2e` and `platform` jobs never ran in the last failed runs, so new failures may appear once `check` passes. The failure loop covers them, within 3 rounds.
- `mongo:4.4` pre-pull may not remove the rate limit if the runner is throttled. Fallback is a retry wrapper around the pull.
