# Plan: fix the two unit test timeouts

## Goal and done check

The full unit suite passes with no timeouts. Done check: `pnpm test` from the repo root reports 0 failed files and 0 failed tests. It ran 6758 passed, 1 failed and 55 skipped before any change.

## Constraints and do-not-change list

- Only raise explicit timeouts in the two test files. Do not touch production code, `vitest.config.ts`, `packages/ui/vitest.config.ts` or any other test.
- Do not change what a test asserts.
- Do not touch the other uncommitted work in the tree (see the handoff `docs/handoffs/2026-10-14-e2e-wiring-journeys.md`).
- `docs/screenshots` is not involved.

## Baseline

Command: `pnpm test` (runs `vitest run --project unit`), about 110 s. Failures before any change, both timeouts under full-suite load.

- `packages/ui/src/editor/language-tokens.test.ts`: `beforeAll` at line 12 fails with "Hook timed out in 10000ms". The hook imports the whole `monaco-editor/editor/editor.api` and registers the mongosh and SQL languages. All 55 tests in the file are skipped as a result. The handoff says it passes when run alone.
- `packages/ui/src/management/DocumentsPanel.test.tsx`: the test "loads up to 200 documents when Load more is pressed" (line 29) fails with "Test timed out in 5000ms" (took 5264 ms).

No vitest config sets a timeout, so the defaults of 5000 ms per test and 10000 ms per hook apply.

## Pattern to copy

Pass a timeout as the last argument, for example `beforeAll(async () => { ... }, 60_000)` and `it('...', async () => { ... }, 20_000)`. Check `git grep -n "_000)" packages/ui/src` first for an existing convention and match it.

## Tasks

| Id  | Edits                                                | Reads                    | Model | Waits for |
| --- | ---------------------------------------------------- | ------------------------ | ----- | --------- |
| T1  | `packages/ui/src/editor/language-tokens.test.ts`     | same file, lines 1 to 40 | Haiku | none      |
| T2  | `packages/ui/src/management/DocumentsPanel.test.tsx` | same file, lines 1 to 60 | Haiku | none      |
| V1  | none                                                 | both diffs               | Opus  | T1, T2    |

- T1. Add a 60000 ms timeout argument to the `beforeAll` at line 12. Acceptance check, run alone and again with the whole suite in V1: `pnpm vitest run --project unit packages/ui/src/editor/language-tokens.test.ts` passes all 55 tests.
- T2. Add a 20000 ms timeout argument to the one test at line 29. Acceptance check: `pnpm vitest run --project unit packages/ui/src/management/DocumentsPanel.test.tsx` passes.
- V1. Run `git diff -- packages/ui/src/editor/language-tokens.test.ts packages/ui/src/management/DocumentsPanel.test.tsx` and confirm only the timeout arguments changed. Then run `pnpm test` and confirm the done check. If the suite fails somewhere new, report the file and error and do not fix it.

## Phases

- Phase 1 runs T1 and T2 together. They edit different files.
- Phase 2 runs V1.

## Serial resources

None. The unit suite uses no browser, Docker or database. V1 runs `pnpm test` alone, so no other agent runs vitest at the same time.

## Rework rule

A failed validation goes back to the same implementer with the failing output, at most two rounds. After that the coordinator rewrites the brief. If a timeout of 60 s or 20 s is still not enough, that points to a real slowdown and goes back to the planner, not to a bigger number.

## Commit policy

Open, see below. No agent commits until the user decides.

## Risks and open decisions

- Commit policy. The memory note says to commit on `main`. The work is on `architecture-redesign` and the tree has uncommitted work from the e2e wiring session. The two test edits should not be mixed into that work without a decision. Proposed default is to leave both edits uncommitted and let the user pick.
- Raising timeouts hides a slow test rather than speeding it up. The `DocumentsPanel` test at 5.3 s may be slow even without load. V1 should note its time when run alone.
- Task count is 3 (two implementers and one validator). The Sonnet coordinator writes `docs/plans/2026-10-15-unit-test-timeouts.status.md` with one line per task.
