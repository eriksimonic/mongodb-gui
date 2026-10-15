# Plan: the all-platform tier

## Goal and done check

Test layers run like this:

1. Unit and lint run on Linux, Windows and macOS. This already holds for `check` in `ci.yml`.
2. Integration, wiring journeys and the coverage check run on Linux only. This already holds.
3. A small platform tier runs on Linux, Windows and macOS. It covers only code that touches the operating system. This does not exist yet and this plan builds it.

Done check, all must pass:

1. `pnpm test` passes with the new platform unit tests (unit job, runs on all three OSes).
2. `E2E_NO_MONGO=1 E2E_PREBUILT=1 pnpm exec playwright test -c e2e/playwright.config.ts persistence.spec.ts` passes on Linux without Docker.
3. `actionlint .github/workflows/ci.yml .github/workflows/release.yml` reports nothing, or a plain YAML parse passes if `actionlint` is not installed.
4. The new CI job and release step run green on Windows and macOS. Agents cannot prove this. It needs a push, see open decisions.

## What the discover agents found

- `ci.yml` runs `check` (lint, typecheck, unit, format) on all three OSes. Build, e2e, integration, wiring and coverage run on `ubuntu-latest` only.
- `release.yml` builds installers on all three OSes. Its only smoke test is `mongodump --version`, on Linux and Windows. macOS is skipped. No job launches the packaged app.
- The three Electron specs in `e2e/tests/` launch the built `out/` entry with Playwright's Electron driver (`e2e/support/app.ts`, `launchApp`). They do not launch an installed app.
- `smoke.spec.ts` and `editor.spec.ts` need MongoDB. `e2e/global-setup.ts` always starts a testcontainers Mongo, which Windows and macOS runners cannot run. `persistence.spec.ts` needs no Mongo.
- The vault uses a master password and a KDF, with no OS keychain. It needs no per-OS journey. Only its file permissions and fsync differ.
- OS-dependent code already has platform-mocked unit tests for backup tools, the Docker socket and pipe, the updater, tools download and extract, spill root and the shell child. No platform test exists for `packages/app/src/main/rpc/picked-paths.ts`, `rpc/export-file.ts`, the CSV CRLF handling in `packages/core/src/transfer/csv.ts`, the absolute-path regex in `packages/core/src/transfer/types.ts`, the native dialogs in `main/index.ts` or `shell.openExternal`.

## Constraints and do-not-change list

- No production behavior change. Only tests, e2e support code and workflow files.
- Do not touch the wiring layer (`e2e/wiring/`), `coverage-map.ts` or the existing specs in `e2e/tests/`.
- Existing Linux jobs keep their commands and need lists.
- `docs/screenshots` is not involved.
- Nothing is pushed by any agent.

## Baseline

- `pnpm test` passes, 358 files and 6814 tests.
- `format:check` fails on `docs/architecture-redesign.md` and `packages/ui/src/profiler/ProfilerPanel.test.tsx`, before this work.
- Docker is not reachable on this machine, so the Electron specs `smoke` and `editor` cannot run locally. `persistence` can once P2 lands.

## Pattern to copy

- Platform unit tests, `packages/app/src/main/tools/paths.test.ts` and `packages/app/src/main/backup/tool-process.test.ts`, which pass a `platform` value.
- Workflow style, the existing `check` matrix job in `.github/workflows/ci.yml` for setup steps.

## Decisions made by the planner

- Windows and macOS runners get a native `mongod` from the package manager (`choco install mongodb` and `brew install mongodb-community`), not a container. The job passes its URI as `E2E_MONGO_URI`. If a native install proves unreliable, the fallback is to run only `persistence.spec.ts` there, with `E2E_NO_MONGO=1`.
- `global-setup.ts` gets two env switches. `E2E_NO_MONGO=1` skips Mongo entirely. `E2E_MONGO_URI` seeds an existing server and skips the container. Both exist to serve this tier, so they are not speculative config.
- The packaged-app smoke reuses `persistence.spec.ts` through an env var `E2E_PACKAGED_EXECUTABLE`. When set, `launchApp` runs that binary and passes no `mainEntry` argument.

## Tasks

| Id  | Edits                                                                                                                                    | Reads                                                                                                                                                 | Model  | Waits for |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------- |
| P1  | new `packages/app/src/main/rpc/picked-paths.test.ts` (or extend it if it exists) and new `packages/app/src/main/rpc/export-file.test.ts` | `picked-paths.ts`, `export-file.ts`, `tools/paths.test.ts`                                                                                            | Haiku  | none      |
| P2  | `packages/core/src/transfer/csv.test.ts`, `packages/core/src/transfer/types.test.ts`                                                     | `csv.ts`, `types.ts`, the same test files                                                                                                             | Haiku  | none      |
| P3  | `e2e/global-setup.ts`, `e2e/support/mongo.ts`                                                                                            | both files, `.github/workflows/ci.yml` e2e job                                                                                                        | Sonnet | none      |
| P4  | `e2e/support/app.ts`                                                                                                                     | the file (lines 60 to 110), `persistence.spec.ts`                                                                                                     | Sonnet | none      |
| P5  | `.github/workflows/ci.yml`                                                                                                               | the `check` and `e2e` jobs, `e2e/global-setup.ts` after P3                                                                                            | Sonnet | P3        |
| P6  | `.github/workflows/release.yml`                                                                                                          | the `build` job (lines 60 to 100), `packages/app/electron-builder.*` or the `build` key in `packages/app/package.json`, `e2e/support/app.ts` after P4 | Sonnet | P4        |

Briefs:

- P1. Add Windows-style cases to the two path helpers' tests. Cases for each function: a path with `..\x` and `C:\a\..\b` traversal, a UNC path `\\host\share\file`, a forward-slash path, and mixed separators. Cases assert the existing behavior. If a case exposes a bug, mark it with `it.fails` plus a comment naming the bug, and report it. Do not fix source.
- P2. Add cases for CRLF and a lone CR in `csv.ts` input and output, and for the absolute-path regex in `types.ts` with `C:\x`, `c:/x`, `\\host\x`, `/x` and a relative path. Same rule on bugs as P1.
- P3. Implement `E2E_NO_MONGO=1` and `E2E_MONGO_URI` as described. Default behavior with neither set must stay the same. Add a unit-free check: the run with `E2E_NO_MONGO=1` of `persistence.spec.ts` passes on Linux.
- P4. Implement `E2E_PACKAGED_EXECUTABLE`. When unset, nothing changes. Keep the clean-log check (`ERROR_LINE`) working.
- P5. Add a job `platform` to `ci.yml`. It runs on `windows-latest` and `macos-latest`, fail-fast off, `needs: build`. Steps are checkout, pnpm and Node setup copied from `check`, download the `app-out` artifact the same way the `e2e` job does, install `mongod` natively, start it, then run `pnpm test:e2e` with `E2E_PREBUILT=1` and `E2E_MONGO_URI`. Do not add Docker. Do not touch the other jobs.
- P6. After the unpacked build step in `release.yml`, add a step on all three OSes that sets `E2E_PACKAGED_EXECUTABLE` to the unpacked app binary and runs `persistence.spec.ts` with `E2E_NO_MONGO=1`. Use the paths from the electron-builder output for each OS (`win-unpacked`, `linux-unpacked`, `mac` or `mac-arm64`). Linux needs `xvfb-run -a`. If the macOS output directory name cannot be read from config, find it with a glob and fail with a clear message.

Validators, all Opus, never the author of the task.

- V-P1, V-P2. Run the new test files, then `pnpm test`. Read the diff. Confirm no source file changed and that any `it.fails` has a bug description.
- V-P3. Run the Linux `persistence.spec.ts` check from the done list. Confirm that, with neither switch set, `git diff` shows the original container path intact.
- V-P4. Build the app with `pnpm build` and `pnpm --filter @mongo-gui/app dist` is too heavy locally, so instead confirm by reading the diff that the unset path is unchanged, and run `persistence.spec.ts` with `E2E_NO_MONGO=1` once.
- V-P5, V-P6. Read the YAML against the pattern, run `actionlint` if present, and check every referenced step output, artifact name and path against the earlier jobs in the same file. Report any guess about runner behavior as a risk, not a pass.

## Phases

- Phase 1. P1, P2, P3 and P4 run together. No file appears in two tasks.
- Phase 2. P5 and P6 run together after P3 and P4. They edit different workflow files.
- Phase 3. Validators run as each task finishes. F1 runs the done checks 1 to 3.

## Serial resources

- One Playwright or Electron session at a time on this machine, held with `flock /tmp/mongo-gui-wiring.lock`. Holders are V-P3 and V-P4.
- `out/` is built once by the coordinator before Phase 1. Validators set `E2E_PREBUILT=1`.
- `ci.yml` is edited only by P5. `release.yml` only by P6.

## Commit policy

Commit on `architecture-redesign`, no push, no attribution lines. The coordinator makes one commit per validated task, with the subject `test(platform): ...` for P1 and P2, `test(e2e): ...` for P3 and P4, and `ci: ...` for P5 and P6. Task-by-task validation comes first. A task that fails twice is dropped and listed.

## Rework rule

A failed validation goes back to the same implementer with the failing output, at most two rounds. Then the coordinator rewrites the brief once.

## Risks and open decisions

- Windows and macOS behavior cannot be proven here. P5 and P6 pass local validation by reading only. Real proof needs a push to a throwaway branch, which is outward-facing, so it needs your go. Until then CI stays untested on those OSes.
- A native `mongod` on a Windows or macOS runner can be slow to install or fail to start. The fallback is in the planner decisions.
- The `editor.spec.ts` print step may behave differently on macOS and Windows. That is the point of running it there, but expect a first failure to be about the runner and not the app.
- Release job time grows by one app launch per OS. Linux needs a virtual display for it.
- No tests cover native dialogs, `shell.openExternal`, code signing or the installer itself. P6 shows only that the packaged app starts and asks for the master password. Dialogs stay manual before a release.
- Journey batch 2 (`docs/plans/2026-10-15-journey-batch-2.md`) is unchanged. It stays Linux only, which this plan now makes the intended design. Both plans touch no common file except through `e2e/` helpers, and batch 2 does not edit `global-setup.ts`, `mongo.ts` or `app.ts`, so they can run in either order.
- The status file is `docs/plans/2026-10-15-platform-tier.status.md`, one line per task in the form `- Id (agent): status, next action`.
- Task count is 13: six implementers, six validators and F1.
