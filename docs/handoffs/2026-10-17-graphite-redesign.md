# Handoff: Graphite design language rollout

Written 2026-10-17 on branch `architecture-redesign`. This session applied the design in `/home/erik/Downloads/Mongo GUI design.pdf` (file `Mongo GUI design.html`, 18 pages) to the UI, plus a set of backend changes the design needed. The PDF and HTML are not in the repo, so copy them to the new machine if you want to compare screens. Page 1 to 4 are the design language, 5 to 18 are screens.

## Read this first: git state

- Local `main` is an ancestor of `architecture-redesign`. The branch has about 35 commits that `main` does not have.
- `origin/main` moved on with 5 commits that local `main` and this branch lack. They include `56eeadf` (Manrope for the UI, Inter for tables, JetBrains Mono for code), `5398060` (JetBrains Mono faces load before Monaco measures), `2b26bad` (connect on run, open only connected nodes in the tree) and `88f6624` (local-build skill, dockerised Electron dev app).
- Those commits overlap this work. The Geist fonts replace Manrope, Inter and JetBrains Mono, and the tree changes touch `ConnectionTree.tsx`. Expect conflicts in `packages/ui/src/theme/theme.ts`, the tree files and the font imports when the two lines of history meet. Resolve the fonts in favour of Geist and Geist Mono, and keep both sides' tree behaviour.
- The user decided that this branch is the source of truth and approved a force push to `origin/main`. The push overwrote the 5 upstream commits. Their last tip was `88f6624`, which `git reflog` or `git branch backup 88f6624` can still reach for a while on a machine that fetched it. Nothing from them was merged, so the Manrope, Inter and JetBrains Mono fonts and the "connect on run" tree behaviour from `2b26bad` are not in this history. Check whether the connect-on-run behaviour is still wanted.

## What the design is

Dark graphite surfaces, one amber action colour, and colour as a signal (blue info, green healthy, orange slow, rose wrong). Geist and Geist Mono. Controls are 30px tall with radius 6, a 4px spacing base, no shadows except on floating layers, and each connection keeps its own colour from a fixed set of eight. `docs/design-language.md` and `docs/color-palette.md` describe the previous language and were not updated. Update or replace them.

## What was done

Tokens and theme

- `packages/ui/src/theme/tokens.css` holds the Graphite values for dark and light, plus signal, series and code-colour tokens (`--mg-ok`, `--mg-warn`, `--mg-danger`, `--mg-link`, `--mg-series-1..6`, `--mg-code-*`, `--mg-border-strong`, `--mg-side`, `--mg-text-faint`).
- `theme.ts`: amber brand ladder (shade 6 is `#f4b223`), new dark ladder, new yellow, orange, red, violet, blue, green and teal ladders, Geist fonts, radius 6, spacing scale 4/8/12/16/24, modal padding 24 with an 18px title, input and label styles.
- Hex values remapped in `palette.ts`, `TableView.tsx`, `kit/code/editor-theme.ts`. The connection colour picker has the eight design colours. Stored connection colours are not migrated.
- The old font packages (`@fontsource-variable/inter`, `manrope`, `@fontsource/jetbrains-mono`) are still in `packages/ui/package.json` and unused. Remove them.

Screens

- Shell: header with outlined Help, Settings and Lock buttons, a Connections panel header with New connection and Manage connections icons (the header "Connections" button is gone), the dock tab strip above the panel is hidden, tabs have a 32px strip, an amber top line on the active tab and 1px separators between inactive tabs.
- Tree: connection colour bar, amber ancestors, outlined active node, document count and size per collection (`48k · 61 MB`, `view` for views).
- Tree search: a search box that stays pinned at the top with a chip per connected server, a scrolling result list, and a footer pinned at the bottom (match count, "Updated N s ago", 500 row cap). It filters a cached name catalog locally on every keystroke. The catalog is fetched with the new `catalog.listNames` request: first fetch immediate, later fetches after a 5 s pause in typing and only when the cache is older than 5 s, plus a refresh button in the box. Ctrl+T focuses the box. The old type-ahead find bar is deleted. Selecting a result expands the server and database, loads collections with stats, and selects the row.
- Editor: toolbar restyle, Saved and Unsaved badges, Translated badge and Copy in the SQL preview. A collection opens with `db.<name>.find({})`, or `SELECT * FROM name;` in SQL mode. Switching language converts an untouched default.
- Results: the JSON view is removed from the toggle (saved `json` tabs map to `table`). Tree view follows page 13: Key, Value, Type, Expand all, Collapse all, Export, pager (20 per page), first document open, tinted type pills. `JsonView` still exists for non-cursor values and the document modal.
- Collection tab (`screens/CollectionPanel.tsx`): header with `db.coll` and stat columns, section tabs Documents, Indexes, Validation, Analyse, Watch, Collection stats. Every tree and menu entry for those panels opens this tab. The old per-kind dock components stay registered so saved layouts load. Documents is still the sampled-documents view. The editor with Table and Tree results stays in its own tab ("Open in editor"). Embedding the editor in Documents was not done.
- Indexes panel: toolbar, detail pane with unused-index callout, Hide index, Copy createIndex, Drop. Create index dialog: numbered key rows, Name and Collation side by side, options grid with descriptions, Command preview, Copy command.
- Profiler: CAPTURE and FILTER rows, op pills, COLLSCAN badges, amber row selection. Monitor: KPI cards, scrolling dashboard area, resize handle on cards (see open items). Explain: editable, colour-coded, expandable query editor (`explain/CommandEditor.tsx`), Re-run uses the edited text, only the graph and detail pane scroll, amber active segment and tab, node badges, "Why it matters" callout.
- Connections: manager is a list with a detail pane, form has Server, Authentication, TLS and Advanced tabs, validation chips, green "Connected in N ms" banner. Dialogs are 640px (form) and 440px (confirm). First run has a repeat-password check mark and a 4-segment strength meter. Unlock keeps "Reset store" (not "Forgot password", because there is no recovery) with a line saying so.
- Docker: connections that came from Docker are removed when their container no longer exists (`packages/app/src/main/docker/prune.ts`). Manual connections are never removed. Nothing is removed when Docker cannot be listed. A `connections:changed` event drives a toast.

Backend

- `catalog.listNames { connectionId }`: one `$listCatalog` call on `admin` (works on 7.0.43 and 8.0.17), falling back to `listDatabases` plus `listCollections` with `nameOnly` and `authorizedCollections`, 8 databases at a time. The fallback is the only path on 4.4 (verified on 4.4.30: `$listCatalog` fails with code 40324). The adapter remembers an unsupported `$listCatalog` per client.
- `collections.list` takes a `withStats` option. Stats come from `$collStats` in batches of 8 with an `estimatedDocumentCount` fallback. A failed lookup omits the fields and never fails the catalog.
- `CollectionInfoSchema` has optional `count` and `size`. The mock RPC client returns both.

## Verification state

Final run before the commit: typecheck clean, lint 0 errors (12 warnings), unit tests 361 files and 6,859 tests all passing. Nothing was checked on CI, and the e2e wiring journeys were not run, so they may need updates for the new tab, tree and dialog layouts.

The UI was checked by screenshots in Chrome against the browser mock UI, taken by Haiku subagents. The Electron app was only run, not inspected. Not verified in any browser:

- the pinned search footer and chip row,
- the light theme on any screen,
- the real stats path in `mongo-adapter` against a server,
- search timing on the 500-database instance.

## Open items

Monitor layout (done, not checked in a browser): the dashboard is rows of panels. Each panel has a width fraction and each row has a pixel height, so every row fills 100% of the width. Dividers and a corner grip resize continuously (240px minimum width, 140px minimum row height), dragging a header shows an amber drop bar and re-tiles the layout, Add panel fills the last row up to 4 panels, below 720px every panel is a full-width row for display only. The saved schema is version 2 (`rows`, `panels[{id, f}]`, `h`) in `packages/core/src/monitor/dashboard-layout.ts`, and older layouts migrate. Header drag and divider drag have no jsdom tests, so check them by hand. The contrast fix for the Add panel menu is in `tokens.css` (Mantine dimmed, placeholder and disabled colours now follow the theme). The worst computed pair is `--mg-text-muted` on `--mg-hover` in light, 4.54:1. The Add badge text and the picker's hover and selected states were not measured.

Not done, needs data or APIs the app lacks: READ ONLY badge, query history count in the connection manager, the Quit link on the unlock screen, the first-run auto-lock toggle, storage engine and created date in the collection subtitle, the output dock header with a collapse chevron and collapse on dashboards, Expand all and Collapse all in the Table view.

Other follow-ups:

1. Refresh the four pinned screenshots in `docs/screenshots` (`query`, `explain`, `profiler`, `diagnostics`). They are stale. Use a Haiku subagent at 1280x800 in the dark theme, per `CLAUDE.md`.
2. Look at the light theme on every screen. Mantine's light scheme paints some inputs from its own grays.
3. Search performance: time the search on the 500-database instance (`dev/many-collections/up.sh`). The tree is not virtualised, so thousands of results render up to the 500 row cap.
4. A recreated Docker container gets a new id, so its old connection is removed and its name, colour and history are lost. Decide whether to match by container name.
5. Replace the hard-coded `gap={4}` and `gap={6}` values in the connection form and the Export and Shard dialogs.
6. `docs/design-language.md` and `docs/color-palette.md` describe the old language.
7. `CatalogMenus` export-dialog test failed once in a full run and passed alone.

## Test fixtures

Start them from the repo root. All are single mongod containers with no auth, and all keep their data in Docker volumes.

- `dev/explain-lab/up.sh`: MongoDB 8.0.17 on `mongodb://127.0.0.1:27218/explain_lab`.
- `dev/grid-perf/up.sh`: MongoDB 7.0 on `mongodb://127.0.0.1:27217/grid`.
- `dev/many-collections/up.sh` (new): MongoDB 7.0 on `mongodb://127.0.0.1:27219/`, 500 databases and 50,000 collections in five application profiles (shop, crm, cms, iot, logistics), names like `amber_falcon_shop`. It needs `--ulimit nofile`, which the script sets. Seeding takes about 20 minutes and is safe to rerun. The volume is `mongo-gui-many`.
- `dev/replica-set/up.sh`: three-member replica set, seeds 1,000,000 documents. Not started this session.

## How to run

- Browser mock UI: `pnpm dev:ui`, then `http://localhost:5174/?preset=unlocked`. A tree row opens with a double-click.
- Electron: `cd packages/app && nohup pnpm exec electron-vite dev --noSandbox > /tmp/electron.log 2>&1 &`. The log line `shell state changed` did not appear this session even though the app worked. Restart it after changes under `packages/app/src/main`. See `.claude/skills/run-app/SKILL.md`.
- Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`. For colour and style edits run only typecheck. The unit suite takes about 2 minutes.

## Working notes

- Implementation was split over five subagents by directory (shell and tree, editor and results, profiler, monitor and explain, connections and login, collection and indexes), then follow-up rounds. Every subagent was told to run typecheck only. Haiku subagents took the screenshots.
- A stale Vite module once blanked the page after a `sed` edit. If the page goes blank with a `ReferenceError`, touch the file or restart the dev server before debugging the source.
- The mock UI viewport in Chrome was 1568x699, not 1280x800.
