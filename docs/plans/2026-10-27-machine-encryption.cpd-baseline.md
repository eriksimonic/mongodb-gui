# Machine encryption: CPD baseline (T0)

Taken on 2026-10-27 on branch `feat/machine-encryption`, before any change for this plan. Tool: PMD CPD (latest release, run in `eclipse-temurin:21-jre` through Podman because Java is not installed on the host). Settings: `--language typescript --minimum-tokens 100` (the skill's starting value), exact token matches only. Scope: every tracked `.ts` and `.tsx` file under `packages/storage/src`, `packages/core/src`, `packages/app/src` and `packages/ui/src`, excluding `.d.ts` (922 files). Line ranges are the first line of each copy through the last line of the duplicated block. Test files are included, as the scan was run without filtering.

Total: 28 clusters.

### C1. 30 lines, 316 tokens

- `packages/core/src/sql/break-semantics.test.ts`: 10-39
- `packages/core/src/sql/index.test.ts`: 15-44

### C2. 29 lines, 272 tokens

- `packages/core/src/sql/break-joins-groups.test.ts`: 8-36
- `packages/core/src/sql/break-semantics.test.ts`: 9-37

### C3. 40 lines, 261 tokens

- `packages/app/src/main/rpc/management.test.ts`: 50-89
- `packages/app/src/main/rpc/sharding.test.ts`: 44-83

### C4. 28 lines, 258 tokens

- `packages/core/src/sql/break-hostile-input-2.test.ts`: 8-35
- `packages/core/src/sql/break-joins-groups.test.ts`: 9-36
- `packages/core/src/sql/break-semantics.test.ts`: 10-37

### C5. 40 lines, 256 tokens

- `packages/app/src/main/rpc/management.test.ts`: 50-89
- `packages/app/src/main/rpc/replication.test.ts`: 54-93
- `packages/app/src/main/rpc/sharding.test.ts`: 44-83

### C6. 28 lines, 252 tokens

- `packages/core/src/sql/break-hostile-input-2.test.ts`: 8-35
- `packages/core/src/sql/index.test.ts`: 15-42

### C7. 28 lines, 252 tokens

- `packages/core/src/sql/break-joins-groups.test.ts`: 9-36
- `packages/core/src/sql/index.test.ts`: 15-42

### C8. 22 lines, 210 tokens

- `packages/core/src/sql/break-hostile-input-2.test.ts`: 18-39
- `packages/core/src/sql/break-hostile-input.test.ts`: 30-51

### C9. 8 lines, 196 tokens

- `packages/storage/src/store/migrations.ts`: 48-55
- `packages/storage/src/store/migrations.ts`: 59-66

### C10. 33 lines, 192 tokens

- `packages/app/src/main/rpc/diagnostics.test.ts`: 37-69
- `packages/app/src/main/rpc/security.test.ts`: 41-73

### C11. 17 lines, 151 tokens

- `packages/app/src/main/rpc/backup.test.ts`: 275-291
- `packages/app/src/main/rpc/router.test.ts`: 174-190

### C12. 14 lines, 149 tokens

- `packages/app/src/main/rpc/backup.test.ts`: 278-291
- `packages/app/src/main/rpc/router.updates.test.ts`: 23-36

### C13. 14 lines, 149 tokens

- `packages/app/src/main/rpc/router.test.ts`: 177-190
- `packages/app/src/main/rpc/router.updates.test.ts`: 23-36

### C14. 18 lines, 144 tokens

- `packages/core/src/sql/break-hostile-input.test.ts`: 30-47
- `packages/core/src/sql/break-joins-groups.test.ts`: 19-36
- `packages/core/src/sql/break-semantics.test.ts`: 20-37
- `packages/core/src/sql/index.test.ts`: 25-42

### C15. 22 lines, 137 tokens

- `packages/app/src/main/shell/supervisor.test.ts`: 488-509
- `packages/app/src/main/shell/supervisor.test.ts`: 884-905

### C16. 22 lines, 135 tokens

- `packages/app/src/main/rpc/gridfs.integration.test.ts`: 41-62
- `packages/app/src/main/rpc/transfer.integration.test.ts`: 41-62

### C17. 23 lines, 127 tokens

- `packages/app/src/main/rpc/management.test.ts`: 1-23
- `packages/app/src/main/rpc/sharding.test.ts`: 1-23

### C18. 16 lines, 127 tokens

- `packages/app/src/main/tools/archive/extract.test.ts`: 26-41
- `packages/app/src/main/tools/archive/zip.test.ts`: 35-50

### C19. 21 lines, 124 tokens

- `packages/app/src/main/rpc/diagnostics.test.ts`: 1-21
- `packages/app/src/main/rpc/security.test.ts`: 1-21

### C20. 4 lines, 122 tokens

- `packages/storage/src/store/migrations.ts`: 23-26
- `packages/storage/src/store/migrations.ts`: 48-51
- `packages/storage/src/store/migrations.ts`: 59-62

### C21. 59 lines, 117 tokens

- `packages/core/src/sql/parser.ts`: 28-86
- `packages/ui/src/editor/sql-format.ts`: 12-70

### C22. 15 lines, 114 tokens

- `packages/core/src/sql/break-hostile-input-2.test.ts`: 8-22
- `packages/core/src/sql/break-hostile-input.test.ts`: 13-27
- `packages/core/src/sql/break-joins-groups.test.ts`: 9-23
- `packages/core/src/sql/break-semantics.test.ts`: 10-24

### C23. 15 lines, 111 tokens

- `packages/core/src/sql/break-hostile-input.test.ts`: 13-27
- `packages/core/src/sql/index.test.ts`: 15-29

### C24. 16 lines, 107 tokens

- `packages/app/src/main/rpc/gridfs.integration.test.ts`: 93-108
- `packages/app/src/main/rpc/transfer.integration.test.ts`: 91-106

### C25. 19 lines, 105 tokens

- `packages/app/src/main/rpc/monitor.integration.test.ts`: 42-60
- `packages/app/src/main/rpc/router.integration.test.ts`: 51-69

### C26. 1 lines, 102 tokens

- `packages/ui/src/explain/mock.test.ts`: 6-6
- `packages/ui/src/state/explain-store.test.ts`: 252-252

### C27. 13 lines, 101 tokens

- `packages/core/src/sql/translate.test.ts`: 2877-2889
- `packages/core/src/sql/translate.test.ts`: 2973-2985

### C28. 20 lines, 100 tokens

- `packages/storage/src/store/favourites-repo.test.ts`: 1-20
- `packages/storage/src/store/layout-repo.test.ts`: 1-20
