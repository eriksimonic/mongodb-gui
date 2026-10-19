# Baseline (T0), before any change

- lint (`pnpm run lint`): PASS, exit 0. 0 errors, 12 warnings (react-hooks/incompatible-library on TanStack `useVirtualizer` in SlowQueryTable.tsx, TreeView.tsx, SchemaFieldTable.tsx, and others).
- typecheck (`pnpm run typecheck`, `tsc -b`): PASS, exit 0.
- test (`pnpm test`, vitest unit): FAIL, exit 1. 7 failed, 6870 passed, 6 skipped (6883). 5 of 361 files failed.
  - backup-service.test.ts > restores a database folder from a private folder that holds only a link to it
  - rpc/backup.test.ts > refuses a backup into a folder that was not picked, and writes into the real folder
  - rpc/export-file.test.ts > exportTargetProblem > refuses a symbolic link at the target
  - rpc/router.test.ts > export in parts > refuses a symbolic link at the target
  - rpc/router.test.ts > file picks > refuses a folder download through a symlink that leads out of the picked folder
  - rpc/router.test.ts > file picks > allows a picked folder that is itself a symlink to the real folder
  - tools/registry.test.ts > remove > ignores a symbolic link in the downloaded root
  - First error: `EPERM: operation not permitted, symlink ... -> ...`. Cause: Windows without symlink privilege (no Developer Mode or admin). Environment issue, not a code regression.
- test:integration (`pnpm run test:integration`): NOT COMPLETED. Docker not installed (`docker: command not found`). The run produced no output for about 30 min and was stopped manually (TaskStop). Result: no pass/fail recorded.
