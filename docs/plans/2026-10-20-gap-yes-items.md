# Gap matrix "yes" items: fluent queries, syntax check, binary viewer

Status: approved by the owner on 2026-10-20 for items 2, 3 and 4 only. The write guard and copy (item 1 of the first draft) were cut by the owner, who fears users would rely on the guard and make mistakes. The numbering of items 2 to 4 is kept so the task ids stay stable.

## Goal and done check

Ship three work items, one branch each, in this order:

2. `feat/fluent-query`: `db.orders.where("age").gte(18).sort(...)` in the shell (item C).
3. `feat/syntax-check`: red underlines for mongosh syntax errors while typing (item D).
4. `feat/binary-viewer`: a read-only "View binary" view for Binary values (item E).

An item is done when all of these hold:

- `pnpm run check` passes, with no failure that is not in the baseline file (T0b).
- The item's integration and wiring checks listed in its final validator task pass.
- A validator walked the item in the browser mock UI (`pnpm dev:ui`, 1536x1024, dark theme) and looked at a screenshot of each new screen. Screenshots go to `e2e/output`.
- `git diff --name-only <item base>...HEAD` plus `git status --porcelain` list only files the item's tasks name, plus this plan, its status file and its baseline file. The untracked `.pi/` folder is ignored. `docs/screenshots` is unchanged. `<item base>` is the commit the item branch started from, which the coordinator writes at the top of the status file.
- The coordinator committed the item on its branch and the owner's TODO-AI review of it is closed (task R of the item).

The write guard, copy of collections and databases, compare and sync, schema documentation export, reschema, export to SQL file and import from SQL database are out of scope. Task CD, DD or ED only notes them as "Later" in `docs/gap-matrix.md` if a row is not already marked.

## Constraints and do-not-change

- Do not rename or change existing RPC calls, events or schemas. Only add fields and calls. A new field on an existing schema is optional or has a default.
- No new runtime dependency except `acorn` in `packages/ui` (task D1).
- Simplest code that meets the task. No interface, base class, factory or wrapper for one implementation. Functions over classes. Named exports only. Match the style of the file you edit.
- Prose in docs, comments, commit messages and UI strings follows `~/.claude/skills/unslop/SKILL.md`: plain words, sentence case, no em dashes.
- Tests and scripts write images to `e2e/output`.

## Commit policy

- One branch per item, named as in the goal. Each item branches from `main` after the owner merged the previous item, or from the previous item's tip if the owner says so.
- The coordinator commits once per phase that passed its checks. Plain subject in the repo style (`feat(shell): ...`, `feat(editor): ...`, `docs: ...`) and a short body. No `Co-Authored-By`, no model or tool names, no trailers of any kind. No push, no PR, unless the owner asks.
- After an item's last validator passes, the coordinator reports to the owner and stops. The owner reviews by adding `//TODO-AI` comments. No agent edits any file of the repo while that review is open.
- When the owner says the review is done, task R of the item runs (see "Review task R").
- The next item starts only after task R of the previous item is committed.

## Baseline (T0b writes the result)

Commands, from the repo root:

- `pnpm run lint` (`eslint .`)
- `pnpm run typecheck` (`tsc -b`)
- `pnpm test` (`vitest run --project unit`)
- `pnpm run test:integration` (`vitest run --project integration --passWithNoTests`, needs Docker)
- `pnpm run test:e2e` (`playwright test -c e2e/playwright.config.ts`, needs the browser)
- `pnpm run test:wiring` (`playwright test -c e2e/wiring/playwright.config.ts`, needs Docker and the browser)
- `pnpm run knip` (`knip --production --exclude duplicates`)
- `pnpm run format:check` (`prettier --check .`)

T0b records which of them fail before any change, with the failing test names, in `docs/plans/2026-10-20-gap-yes-items.baseline.md`. No later agent blames a failure listed there on its own work. T0c and T0d run again at the start of items 3 and 4 and append a section per item.

## Pattern to copy

New RPC calls follow commit `1d6d0f5` (storage panel, `git show --stat 1d6d0f5`):

- Contract entry with `defineCall(zod input, zod output)` in `packages/core/src/rpc/contract.ts` (shell calls at 365-378, backup calls at 631-637).
- Types in `packages/core/src/<feature>/`, re-exported from `packages/core/src/index.ts` (backup exports at 5-14).
- Handler in `packages/app/src/main/rpc/<file>.ts` (`entry(...)` as in `packages/app/src/main/rpc/shell.ts:61-102`, `packages/app/src/main/rpc/backup.ts:115-160`).
- UI mock in `packages/ui/src/<feature>/mock.ts`, wired in `packages/ui/src/api/mock-rpc-client.ts` (backup at 708 and 739-762, shell at 1173-1200).
- One line per new call in `e2e/coverage-map.ts`. `tests/coverage-map.test.ts:10` fails without it.
- A new contract namespace needs its name in `packages/core/src/rpc/contract.test.ts:9-30`.
- A contract entry without a handler fails `packages/app/src/main/rpc/router.test.ts:322` ("answers every contract method"). The phase tables say when that red window is expected.
- A new contract entry also needs a method in the mock client, or root typecheck fails, because `mock-rpc-client.ts:710` types the mock as `RpcClient`.

Events: `packages/core/src/schemas/events.ts:17-110` (`RpcEventSchema`). The supervisor's events reach the renderer through `packages/app/src/main/rpc/router.ts:484-486`. The UI subscribes with `onEvent` from `useUiApi()` as in `packages/ui/src/backup/use-backup-job.ts:48-71`.

Jobs with progress: `packages/app/src/main/backup/backup-service.ts` (`BACKUP_PROGRESS_INTERVAL_MS = 250` at 55, deps at 61-91, service API at 93-106, `createBackupService` at 283, `runRestore` at 563). Tools are spawned with `runTool` in `packages/app/src/main/backup/tool-process.ts:15-50`, `:66-170` (stdin and stdout piping at 85, 154-165).

Two-server integration tests: `packages/app/src/main/backup/backup.integration.test.ts:1-150` with `startMongo` from `packages/mongo-adapter/src/test/mongo-container.ts:33`.

## Roles and models

- Coordinator: Sonnet. Sends tasks, tracks status in `docs/plans/2026-10-20-gap-yes-items.status.md` (one line per task: `- id: status, next action`), runs the phase-end checks, commits. Writes no feature code.
- Implementers and discover tasks: Haiku, about 100k tokens of context each. Each task edits only its listed files and reports in at most 10 lines.
- Spike C1: Opus. Its result decides the next tasks.
- Validators: Opus. Never the agent that wrote the code.

Every task brief from the coordinator is: this plan's path, the task id, and nothing else. A Haiku implementer that finds the plan wrong (a missing file, a line range that moved by more than 30 lines, a name that clashes) reports the problem and stops. It does not guess.

## Phase-end checks (coordinator)

`tsc -b` writes build output, so two parallel runs corrupt it. Implementers run only their own vitest command. After each phase the coordinator alone runs `pnpm run typecheck`, `pnpm run lint` and `pnpm test`, and sends each failure to the task that owns the file. Expected red windows are named in the phase tables. Anything else that is red and not in the baseline blocks the next phase.

The planner checked that new union members (`ShellRequestSchema`, `ShellResponseSchema`, `FindingCodeSchema`, `RpcEventSchema`) break no build on their own. `eslint.config.js:42` uses `tseslint.configs.strict` without `switch-exhaustiveness-check`, `tsconfig.base.json` has no `noImplicitReturns`, and no `assertNever`, `Record<FindingCode` or `Record<RpcEvent` exists under `packages`. So the router test is the only expected red window.

Vitest commands in this plan use the root projects, for example `pnpm exec vitest run --project unit packages/core/src/shell/fluent-prelude.test.ts`.

After any change under `packages/shell-runtime`, run `pnpm --filter @mongo-gui/app run build:shell-runtime` before a wiring or e2e run.

---

# Item 2: fluent query API (`feat/fluent-query`)

## Names and behavior

- New file `packages/shell-runtime/src/fluent-prelude.ts` exporting `FLUENT_PRELUDE`, a string of mongosh code.
- `open()` (`packages/shell-runtime/src/session.ts:418-446`) evaluates `FLUENT_PRELUDE` after the `use(...)` call at 442-444, and also when `database` is undefined. `open()` runs again on every reopen, so the prelude does too.
- `coll.where(field)` returns a clause object with `equals(value)`, `gt`, `gte`, `lt`, `lte` (one value each), `in(array)`, `nin(array)`, `regex(pattern, flags?)` and `exists(flag = true)`.
- Each clause method returns an ordinary mongosh cursor, `coll.find(filter)`, with three extra methods on that cursor object: `and(field)` and `or(field)` return a clause object that builds on the same filter, and `select(spec)` calls `projection`. Cursor methods such as `sort`, `limit` and `skip` return the same cursor, so `select` works after them. `and` and `or` start a new `find`, so they come before `sort`, `limit` and `skip`.
- Filter rules. The query is a list of groups. `and` adds a clause to the last group, `or` starts a new group. A group becomes one object that merges the clauses per field. `equals` gives `{ f: v }`, or `$eq` when the same field has another operator in the group. When a group has the same operator twice on one field, the group becomes `{ $and: [ one object per clause ] }`. One group is the filter. Several groups become `{ $or: [ ... ] }`.
- `regex("^a", "i")` gives `{ $regex: "^a", $options: "i" }`. A RegExp argument gives `{ $regex: /.../ }`.
- `select("name -_id")` gives `{ name: 1, _id: 0 }`. An object passes through.
- Expected filters:
  - `where("age").gte(18)` gives `{ age: { $gte: 18 } }`
  - `where("age").gte(18).and("age").lt(65)` gives `{ age: { $gte: 18, $lt: 65 } }`
  - `where("status").equals("A").and("qty").in([1, 2])` gives `{ status: "A", qty: { $in: [1, 2] } }`
  - `where("status").equals("A").or("qty").gt(10)` gives `{ $or: [ { status: "A" }, { qty: { $gt: 10 } } ] }`
  - `where("a").gt(1).and("a").gt(2)` gives `{ $and: [ { a: { $gt: 1 } }, { a: { $gt: 2 } } ] }`
  - `where("a").equals(1).and("a").gt(0)` gives `{ a: { $eq: 1, $gt: 0 } }`
  - `where("email").exists()` gives `{ email: { $exists: true } }`
- A bare `db.orders.where("age").gte(18)` prints as a cursor result, so `isCursorResult` (`session.ts:252`) is true and the UI shows the table.

## Tasks, item 2

### T0b baseline (Haiku, discover)

- Edits: `docs/plans/2026-10-20-gap-yes-items.baseline.md` (create it, section "Item 2")
- Waits for: the owner approving this plan
- Check: as T0b.

### C1 spike: prelude adds where() (Opus)

- Edits: `packages/shell-runtime/src/fluent-prelude.ts` (new), `packages/shell-runtime/src/fluent.integration.test.ts` (new), `packages/shell-runtime/src/session.ts`
- Reads: `session.ts:240-271`, `:313-358`, `:418-446`; `packages/shell-runtime/src/session.integration.test.ts` (setup); "Names and behavior" above
- Waits for: T0b
- Holds: Docker
- What to prove: a prelude evaluated in `open()` can add `where` to collections so `db.orders.where` is the method and not a sub-collection named `orders.where`; the methods survive `use other`; the prelude prints nothing and leaves no history; completion of `db.orders.` still works.
- Pass criteria in `fluent.integration.test.ts`: every expected filter above returns the same documents as `find` with that filter; `sort`, `limit`, `skip` and `select` work after a clause; the bare form returns a cursor result with `hasMore` on 25 documents and batch size 20; `where` works after `use("other")`; a reopened runtime still has `where`.
- On pass: C2, C3 and CD run as written.
- On fail: the coordinator stops item 2 and asks the owner, with the spike's notes. Items 3 and 4 do not depend on item 2, so the coordinator also asks whether to start item 3.
- Check: `pnpm exec vitest run --project integration packages/shell-runtime/src/fluent.integration.test.ts`

### C2 completion and signature help (Haiku)

- Edits: `packages/ui/src/editor/operators.ts`, `packages/ui/src/editor/completion-model.ts`, `packages/ui/src/editor/completion-model.test.ts`, `packages/ui/src/editor/signature.ts`
- Reads: `operators.ts:110-130`, `:220-247`, `:305-358`; `completion-model.ts:20-90`, `:180-210`; `signature.ts:1-60`; `packages/ui/src/editor/mongosh-language.ts:34-63` (where the providers call these)
- Waits for: C1
- Spec: add `where` to `COLLECTION_METHODS` with parameter `field` and doc `Starts a fluent query on a field. Chain a comparison such as gte(18).` Add `FLUENT_CLAUSE_METHODS` (equals, gt, gte, lt, lte, in, nin, regex, exists, each with one parameter, `regex` with `pattern` and optional `flags`, `exists` with optional `flag`) and `FLUENT_CURSOR_METHODS` (and, or with `field`; select with `spec`) in `operators.ts`. `findMethod` finds them. `staticCompletionsFor` offers `where` when `memberOfCollection` is true. Add a context flag `fluentClause: boolean` to `CompletionContext` (`completion-model.ts:20-41`), true when the head ends with `.where(...).`, `.and(...).` or `.or(...).` (the last call before the dot is one of those three). With it, offer only `FLUENT_CLAUSE_METHODS`. Add the clause method names (`equals|gt|gte|lt|lte|in|nin|regex|exists`) to `CURSOR_CALL` (`completion-model.ts:54`), and not `where`, `and` or `or`, so `cursorMember` holds after a clause call. After a clause call and a dot, offer `FLUENT_CURSOR_METHODS` plus `CURSOR_METHODS`. When `fluentClause` is true, `cursorMember` is ignored, so cursor methods never show where a clause method belongs. Tests: `db.orders.` offers `where`; `db.orders.where("a").` offers `gte` and not `sort`; `db.orders.where("a").gte(1).` offers `and`, `select` and `sort` and not `gte`; the signature of `gte(` and `regex(`.
- Check: `pnpm exec vitest run --project unit packages/ui/src/editor/completion-model.test.ts packages/ui/src/editor`

### C3 fluent wiring journey (Haiku)

- Edits: `e2e/wiring/journeys/standalone/fluent.spec.ts` (new)
- Reads: `e2e/wiring/journeys/standalone/find.spec.ts`
- Waits for: C1. Run `pnpm --filter @mongo-gui/app run build:shell-runtime` first.
- Holds: Docker and the browser
- Spec: run `db.<journey collection>.where("<field>").gte(<value>).sort({ <field>: 1 }).limit(5)` and expect the table with the right first row. No coverage-map change, since no RPC is new.
- Check: `pnpm run test:wiring -- fluent`

### V5 validator, item 2 (Opus)

- Waits for: C2, C3
- Reruns C1 to C3 checks, reads the prelude for global names it adds (only `where` on collections and the three cursor methods), and checks in the Electron-free browser mock that completion offers `where` after `db.orders.` (the mock shell does not run `where`, which is expected).
- Check: verdict in the status file.

### CD docs for item 2 (Haiku)

- Edits: `CHANGELOG.md`, `docs/user-guide.md`, `docs/gap-matrix.md`
- Reads: `docs/user-guide.md:240-285` (The editor), `docs/gap-matrix.md:41`
- Waits for: V5
- Spec: changelog bullet; a `### Fluent queries` subsection in `## The editor` with the method list, two examples and the rule that `and`/`or` come before `sort`/`limit`/`skip`; gap-matrix row 41 becomes `Have`.
- Check: `pnpm exec prettier --check CHANGELOG.md docs/user-guide.md docs/gap-matrix.md`

## Phases, item 2

| Phase  | Tasks                          | Notes                             |
| ------ | ------------------------------ | --------------------------------- |
| 0      | T0b                            | holds Docker and the browser      |
| 1      | C1                             | holds Docker                      |
| 1 gate |                                | C1 failed: stop and ask the owner |
| 2      | C2, C3                         | C3 holds Docker and the browser   |
| 2v     | V5                             | holds the browser                 |
| 3      | CD                             |                                   |
| 4      | commit check, owner review, R2 |                                   |

---

# Item 3: syntax check (`feat/syntax-check`)

## Names and behavior

- Dependency `acorn` `^8.19.0` in `packages/ui/package.json` `dependencies`. It is already in `pnpm-lock.yaml` as a transitive 8.19.0.
- New file `packages/ui/src/editor/syntax-check.ts`:
  - `SYNTAX_CHECK_DEBOUNCE_MS = 400`.
  - `syntaxMarkers(code: string): EditorMarker[]` (`EditorMarker` from `packages/ui/src/editor/editor-events.ts:28-32`). It replaces every character of lines that start with a mongosh shell command (`/^\s*(use|show|it|exit|quit|help)\b.*$/gm`) with spaces, so offsets stay the same. It parses with `acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, allowHashBang: true })`. Valid text returns `[]`. A `SyntaxError` returns one marker from `pos` to `pos + 1`, moved to `[length - 1, length]` when `pos` is at the end, with the message minus acorn's trailing ` (line:column)`.
- `EditorView.tsx`: for a tab whose language is `mongosh`, an effect on `current.text` waits `SYNTAX_CHECK_DEBOUNCE_MS` and then emits `{ type: 'editor:markers', tabId, markers: syntaxMarkers(current.text) }` through `editorUiEvents` as `EditorView.tsx:186-193` does for SQL. It emits an empty list for valid text. SQL tabs are untouched. No collection or field checks.
- The editor already clears markers on the next change (`packages/ui/src/editor/MongoshMonaco.tsx:182-200`), then the debounce sets them again.

## Tasks, item 3

### T0c baseline (Haiku, discover)

- Edits: `docs/plans/2026-10-20-gap-yes-items.baseline.md` (append "Item 3")
- Waits for: item 2 task R committed, or the owner's go after a C1 failure
- Check: as T0b.

### D1 acorn and the checker (Haiku)

- Edits: `packages/ui/package.json`, `pnpm-lock.yaml`, `packages/ui/src/editor/syntax-check.ts` (new), `packages/ui/src/editor/syntax-check.test.ts` (new)
- Reads: `packages/ui/src/editor/editor-events.ts:15-40`, `packages/ui/src/editor/statements.ts:1-35`
- Waits for: T0c
- Holds: the lockfile. Run `pnpm --filter @mongo-gui/ui add acorn@^8.19.0` and nothing else that installs.
- Spec: as above. Tests: valid `db.orders.find({})` gives `[]`; `use shop` then a valid line gives `[]`; `await db.x.findOne()` gives `[]`; `db.orders.find({` gives one marker at the end; `db.orders.find({a:1)}` gives a marker at the `)`; the message has no `(1:17)` suffix; offsets after a blanked `use` line are right.
- Check: `pnpm exec vitest run --project unit packages/ui/src/editor/syntax-check.test.ts`

### D2 editor wiring (Haiku)

- Edits: `packages/ui/src/editor/EditorView.tsx`, `packages/ui/src/editor/EditorView.test.tsx`
- Reads: `EditorView.tsx:160-200`, `:445-462`; `packages/ui/src/editor/MongoshMonaco.tsx:170-205`; `EditorView.test.tsx` (setup); D1's `syntax-check.ts`
- Waits for: D1
- Spec: as above. Tests with fake timers: typing broken mongosh emits one `editor:markers` event after 400 ms with one marker; fixing it emits an empty list; a SQL tab emits nothing from this effect.
- Check: `pnpm exec vitest run --project unit packages/ui/src/editor/EditorView.test.tsx`

### V6 validator, item 3 (Opus)

- Waits for: D2
- Holds: the browser and `pnpm dev:ui`
- Reruns D1 and D2 checks. In the mock UI types `db.orders.find({` and sees a red underline and the hover message, then fixes it and sees the underline go. Runs a SQL tab with a refused clause and sees its marker as before. Screenshots to `e2e/output`. `db.orders.find({})` in the pinned `query.png` state has no underline, so no pinned screenshot changes.
- Check: verdict in the status file and `git status --porcelain docs/screenshots` prints nothing.

### DD docs for item 3 (Haiku)

- Edits: `CHANGELOG.md`, `docs/user-guide.md`, `docs/gap-matrix.md`
- Reads: `docs/user-guide.md:240-285`, `docs/gap-matrix.md:38`
- Waits for: V6
- Spec: changelog bullet; a short `### Syntax errors` subsection in `## The editor` (what is checked, that shell commands such as `use` are skipped, that names of collections and fields are not checked); gap-matrix row 38 becomes `Have (syntax check of mongosh text and SQL translation errors)`.
- Check: `pnpm exec prettier --check CHANGELOG.md docs/user-guide.md docs/gap-matrix.md`

## Phases, item 3

| Phase | Tasks                          | Notes              |
| ----- | ------------------------------ | ------------------ |
| 0     | T0c                            |                    |
| 1     | D1                             | holds the lockfile |
| 2     | D2                             |                    |
| 2v    | V6                             | holds the browser  |
| 3     | DD                             |                    |
| 4     | commit check, owner review, R3 |                    |

---

# Item 4: binary viewer (`feat/binary-viewer`)

## Names and behavior

- New file `packages/ui/src/results/binary-model.ts`:
  - `BINARY_VIEW_LIMIT = 1024 * 1024` (bytes shown in hex and text).
  - `binaryOf(value: unknown): { subType: string; bytes: Uint8Array } | undefined` reads canonical EJSON `{ $binary: { base64, subType } }`.
  - `imageTypeOf(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | undefined` by magic bytes: PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, GIF `GIF87a` or `GIF89a`, WebP `RIFF` at 0 and `WEBP` at 8.
  - `hexDump(bytes: Uint8Array, limit = BINARY_VIEW_LIMIT): string`. Lines of 16 bytes: 8-digit hex offset, two spaces, bytes in lowercase hex with an extra space after the eighth, two spaces, then the bytes as text between `|`, with non-printable bytes as `.`.
  - `textOf(bytes: Uint8Array, limit = BINARY_VIEW_LIMIT): string` decodes UTF-8 with `TextDecoder` (not fatal) and replaces control characters other than `\n`, `\r` and `\t` with `.`.
- New file `packages/ui/src/results/BinaryBody.tsx`: `BinaryBody({ path, text })`, where `text` is what `load()` returned. It parses it with `parseEjson` (`result-model.ts:152`). For an image it shows `<img src="data:<mime>;base64,<base64>" alt={`Image in ${path}`}>` scaled to fit 420 px height. The renderer CSP allows `data:` images (`packages/app/src/main/index.ts:218`, `:234`). Otherwise it shows `Tabs` `Hex` and `Text` with `ReadOnlyCode`. When the value is larger than the limit, a dimmed line says `` `Showing the first 1 MB of ${n} bytes.` ``. A value that is not Binary shows the alert `This value is not binary.`
- `ValueModal.tsx` (`packages/ui/src/results/ValueModal.tsx:8-64`) gets an optional prop `view?: 'text' | 'binary'`, default `'text'`. With `'binary'` the body is `BinaryBody`. The Copy button copies the loaded text as today.
- Entry points, read-only:
  - Table cell menu (`packages/ui/src/results/TableView.tsx:135-165`): an item `View binary` after `View value`, shown when the value is Binary and not a UUID: either `bsonTypeOf(cell.value) === 'Binary'` with a subtype other than `03` or `04`, or the value is a shortened marker with `nestedMarker(value)?.t === 'binary'` (`packages/core/src/shell/preview.ts:21-23`, `:253`). Large images arrive as that marker, so the second case is the main one. It opens `ValueModal` with `view: 'binary'` and `load` = `fullValueText(...)` as `View value` does.
  - Tree row actions (`packages/ui/src/results/TreeView.tsx:509-545`): an `ActionIcon` with `IconBinary` size 13, tooltip `View binary`, `aria-label` `` `View binary of ${row.path}` ``, under the same condition.
- Mock data: `bsonSampleDocuments` (`packages/ui/src/api/mock-bson-fixtures.ts:24-60`) gets `thumbnail`, a 1x1 PNG as subtype `00` with base64 `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==`, and `payload`, 64 deterministic bytes (`(seed * 7 + index * 31) % 256`) as subtype `00`. These are in `shop.bson_samples`, which no pinned screenshot shows.
- No binary editing, no GridFS change.

## Tasks, item 4

### T0d baseline (Haiku, discover)

- Edits: `docs/plans/2026-10-20-gap-yes-items.baseline.md` (append "Item 4")
- Waits for: item 3 task R committed
- Check: as T0b.

### E1 binary model and mock data (Haiku)

- Edits: `packages/ui/src/results/binary-model.ts` (new), `packages/ui/src/results/binary-model.test.ts` (new), `packages/ui/src/api/mock-bson-fixtures.ts`
- Reads: `packages/ui/src/results/result-model.ts:93-135`, `:430-447`; `mock-bson-fixtures.ts:1-60`
- Waits for: T0d
- Spec: as above. Tests: each magic number and a non-image; hex lines for 0, 15, 16 and 17 bytes; the limit cut; text with control bytes; `binaryOf` on a UUID and on a non-binary.
- Check: `pnpm exec vitest run --project unit packages/ui/src/results/binary-model.test.ts packages/ui/src/api`

### E2 binary body in the value modal (Haiku)

- Edits: `packages/ui/src/results/BinaryBody.tsx` (new), `packages/ui/src/results/BinaryBody.test.tsx` (new), `packages/ui/src/results/ValueModal.tsx`
- Reads: `ValueModal.tsx`, `packages/ui/src/kit/code/ReadOnlyCode.tsx`, E1's `binary-model.ts`
- Waits for: E1
- Spec: as above. Tests: the PNG shows an `img` with the alt text; plain bytes show the Hex tab first and the Text tab second; a large value shows the limit line; a non-binary shows the alert.
- Check: `pnpm exec vitest run --project unit packages/ui/src/results/BinaryBody.test.tsx`

### E3 menu entry and tree action (Haiku)

- Edits: `packages/ui/src/results/TableView.tsx`, `packages/ui/src/results/TreeView.tsx`, `packages/ui/src/results/TableView.test.tsx`, `packages/ui/src/results/TreeView.test.tsx`
- Reads: `TableView.tsx:100-170`, `:375-404`; `TreeView.tsx:505-580`; `packages/core/src/shell/preview.ts:15-30`, `:245-260` (the shortened Binary marker); `packages/ui/src/results/tree-rows.ts:134-139`; E2's `ValueModal.tsx` props
- Waits for: E2
- Spec: as above. Tests: the cell menu of `thumbnail` has `View binary` and opens the image; a shortened marker `{ $mgTruncated: { t: 'binary', n: 9000 } }` also gets the entry; the menu of `correlation` (UUID) has no `View binary`; the tree row of `payload` has the action and opens the hex view.
- Check: `pnpm exec vitest run --project unit packages/ui/src/results`

### V7 validator, item 4 (Opus)

- Waits for: E3
- Holds: the browser and `pnpm dev:ui`
- Reruns E1 to E3 checks. In the mock UI runs `db.bson_samples.find({})`, opens `View binary` on `thumbnail` (image) and `payload` (hex and text) from the table and from the tree view. Screenshots to `e2e/output`, looked at one by one.
- Check: verdict in the status file and `git status --porcelain docs/screenshots` prints nothing.

### ED docs for item 4 (Haiku)

- Edits: `CHANGELOG.md`, `docs/user-guide.md`, `docs/gap-matrix.md`
- Reads: `docs/user-guide.md:285-333` (Results), `docs/gap-matrix.md:66`
- Waits for: V7
- Spec: changelog bullet; a `### Binary values` subsection in `## Results`; gap-matrix row 66 becomes `Partial (read-only binary viewer: image preview, hex, text; no editing)`.
- Check: `pnpm exec prettier --check CHANGELOG.md docs/user-guide.md docs/gap-matrix.md`

## Phases, item 4

| Phase | Tasks                          | Notes             |
| ----- | ------------------------------ | ----------------- |
| 0     | T0d                            |                   |
| 1     | E1                             |                   |
| 2     | E2                             |                   |
| 3     | E3                             |                   |
| 3v    | V7                             | holds the browser |
| 4     | ED                             |                   |
| 5     | commit check, owner review, R4 |                   |

---

## Review task R (one per item: R2, R3, R4)

- Runs only after the owner says the review of the item is done.
- The coordinator runs `grep -rn "TODO-AI" --exclude-dir=node_modules .` and sends each file's comments to one Haiku implementer (one file per implementer, at most five in parallel, never two on one file).
- The implementer makes the requested change, or writes the answer to a question in its report, then removes the comment. A comment that asks for a design change the plan does not settle goes back to the owner unchanged.
- Check: the same grep prints nothing, then the item's last validator check and `pnpm run check` pass. The coordinator commits `chore: address review comments` with a body listing the files.

## Serial resources

- Docker (testcontainers). Holders: T0b, C1, C3 in item 2; the baseline runs T0c and T0d of items 3 and 4. The coordinator holds the lock and never gives Docker to two tasks of one phase.
- The browser session (Playwright, the mock UI dev server on `pnpm dev:ui`, screenshots). Holders: T0b, T0c and T0d (`test:e2e`, `test:wiring`), C3, V5, V6, V7. One at a time. The run-app skill says several sessions at once have crashed this machine (`.claude/skills/run-app/SKILL.md:15`).
- `tsc -b` and the root `pnpm` checks: only the coordinator, once per phase.
- `pnpm-lock.yaml` and `pnpm install`: only D1.
- The shell-runtime build (`build:shell-runtime`): run by the task that needs it (C3) while it holds the browser, never in parallel with another build.

## Rework rule

A failed validation goes back to the same implementer with the failing output, at most two rounds. After that the coordinator rewrites the brief (it may split the task or add a file it found missing), and if that still fails, stops and reports to the owner. A failed spike (C1) is not reworked; it stops the item as its "On fail" says.

## Risks and open decisions

- C1 may find that the prelude cannot add `where()` to collections. Then item 2 stops and the owner decides.
- The mock shell (`packages/ui/src/editor/mock.ts`) does not run `where(...)`. The browser mock UI shows its usual unsupported message for it. Item 2 is checked against a real server (C1, C3).
- Items run one after another with owner reviews in between, so the total time depends on the owner's review turnaround.
