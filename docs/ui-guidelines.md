# UI guidelines

Decisions from the diagnostics, connections and profiler work. Follow them for new screens, and change a rule here when a decision changes.

## Layout

- A tab or panel with a list has a toolbar that stays in view and a body that scrolls under it. Table headers stick to the top of the body. `ScrollLayout` and `Toolbar` in `packages/ui/src/diagnostics/common.tsx` do this.
- A list fills the height the panel gives it. Do not set a fixed or maximum pixel height on a list.
- Pixel gaps do not follow the UI font size, but text does. Widths that hold text use `calc(Npx * var(--mg-font-scale, 1))`, so a larger font does not cut text off.
- Give a panel enough padding that its content is not squashed against the edge: about 14 px sideways and 8 px above and below in the bottom panel.
- A dialog that shows a lot of data is wide (up to 1100 px or 94% of the window). An editor inside a dialog can be dragged taller.

## Toolbars and buttons

- Order in a Diagnostics toolbar: Refresh, then inputs and selects, then switches, then actions. A destructive action comes last. Status text is dimmed and sits at the right edge.
- The profiler filter row ends with Refresh. This was asked for by the owner and differs from Diagnostics. Decide on one order if the two views are ever merged.
- Controls in a toolbar share one size (`xs`) and one height, including a segmented control next to a button. Search boxes are 320 px wide.
- Button labels are short enough to fit on one line: Explain, Open in editor, Copy.
- Remove a button that duplicates another path. New connection lives in the Connections dialog and as the + in the Connections panel header, not in the top bar or the empty connection tree.
- A control that belongs with another sits next to it. "Only problematic" is next to Tail and Apply.
- The native menu bar is hidden. Alt shows it.

## Showing data

- Colours and tokens come from `docs/design-language.md`. Use `--mg-link` for info, `--mg-ok` for healthy, `--mg-warn` for slow or warning, and `--mg-danger` for errors.
- Severity colours: fatal and error red, warning orange, info blue, debug grey. Tint the whole row for warning and above, so problems stand out while scrolling.
- Result values are coloured by BSON type in `results/value-color.ts`.
- Show a share as a bar behind the cell (Top time columns). Dim the database part of a namespace so the collection stands out.
- Show a long identifier cut to its start, with the full value on hover and a copy button.
- Show time as relative ("12 s ago", "6 days ago") with the exact time on hover. Never shows as "Never".
- Hide a column that is empty for every row.
- Give byte and duration numbers a readable hint, for example `13306005 (3 h 41 min)`.
- Put a summary strip above a large tree or table (version, uptime, connections).

## Editing

- Edit documents as JSON with plain numbers and ISO dates. Keep a wrapper only where a plain value would change the type on save: `$numberLong`, whole doubles, `NaN`, ObjectId.
- Shell syntax (`ObjectId("...")`, `NumberLong(5)`, as in NoSQLBooster) needs a parser for it on save. It is not built.
- A plain click selects a table row. Ctrl or Cmd click adds or removes a row. A checkbox toggles one row. A double-click opens or connects.
- Toolbar actions that need one row (Edit, Clone, Test, To URI) stay disabled until exactly one row is selected.

## Feedback

- An action that takes time shows progress at once: a spinner on the button and a loading notification that turns into the result.
- A copy action copies the redacted URI. A full URI with the password needs a confirmation.
- A connection file passphrase has at least 4 characters.

## Consistency

- A menu that exists in two places (connection menu and Docker-linked connection menu) comes from one shared item list, so the two never drift apart.
- Settings sit in vertical tabs with a fixed width and a fixed panel height, so the dialog keeps its size between tabs. Each setting is one `SettingRow`: the label and description on the left, the control on the right, and a border below.

## Working in the repo

- Run vitest through the root scripts, not from `packages/ui`.
- A `SIGSEGV` or `SIGTRAP` in a Vitest worker is a known flake. Run the file alone or run the check again.
- Restart the Electron app after a change under `packages/app/src/main`, `packages/shell-runtime` or the core schemas, because the renderer reload does not pick it up. See `.claude/skills/run-app/SKILL.md`.
- Commit messages have a plain subject and body, with no trailers.

## Popups and completion

- A collapse or close button never sits over a scrollbar. Put it in a strip beside the content.
- Completion lists group names (fields, collections) first, then operators, then functions, and sort each group alphabetically. `completionGroup` in `completion-model.ts` owns the order.
- A code editor in a small box renders its suggest widget outside the box (`fixedOverflowWidgets`).
