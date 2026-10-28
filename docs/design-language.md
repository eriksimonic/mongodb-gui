# Design language

The Graphite design as the code defines it. Values come from `packages/ui/src/theme/tokens.css` and `packages/ui/src/theme/theme.ts`. The editor and chart palettes are in `kit/code/editor-theme.ts` and `theme/palette.ts`. Paths are relative to `packages/ui/src`. Where this file and the code disagree, fix this file. Known disagreements are under Open items.

Mantine 8 provides the components. Dockview holds the panels, AG Grid the results tables, uPlot the charts and Monaco the editors.

## Colour tokens

Dark is the default scheme. `theme/AppProviders.tsx` forces the scheme from the setting, so the OS setting has no effect. Each token has a dark and a light value in `tokens.css`.

Surfaces:

| Token                 | Dark      | Light     | Use                                      |
| --------------------- | --------- | --------- | ---------------------------------------- |
| `--mg-bg-sunken`      | `#18191b` | `#fbfaf7` | Dock tab strip                           |
| `--mg-side`           | `#1e1f22` | `#eceae5` | Sidebar and tree panels                  |
| `--mg-surface-0`      | `#1e1f22` | `#f6f4f0` | Page, active tab                         |
| `--mg-surface-1`      | `#25272a` | `#fffefc` | Modals, inactive tabs, context menus     |
| `--mg-surface-2`      | `#2b2d30` | `#fffefc` | Inputs, popups, search box               |
| `--mg-surface-3`      | `#2b2d30` | `#eceae5` | Table headers, disabled buttons          |
| `--mg-border`         | `#393b40` | `#e4e1da` | Dividers and separators                  |
| `--mg-border-strong`  | `#4e5157` | `#d0ccc3` | Input and popup outlines, tab separators |
| `--mg-control-border` | `#7f838a` | `#8a857a` | Unchecked checkbox and radio             |
| `--mg-hover`          | `#34363b` | `#e8e5df` | Hovered tree row                         |
| `--mg-selected`       | `#2e436e` | `#f8e7bd` | Unused, see Open items                   |

Text:

| Token                | Dark      | Light     | Use                                              |
| -------------------- | --------- | --------- | ------------------------------------------------ |
| `--mg-text-strong`   | `#f2f3f5` | `#1a1815` | Titles, active tab, input text                   |
| `--mg-text`          | `#dfe1e5` | `#3d3a35` | Body text, tree labels                           |
| `--mg-text-muted`    | `#9da0a8` | `#6a665f` | Labels, inactive tabs, dimmed text, placeholders |
| `--mg-text-faint`    | `#7a7e85` | `#928d85` | Null values in the grid                          |
| `--mg-selected-text` | `#f2f3f5` | `#1a1815` | Unused, see Open items                           |

Accent and signals:

| Token               | Dark      | Light     | Use                                                                  |
| ------------------- | --------- | --------- | -------------------------------------------------------------------- |
| `--mg-accent`       | `#f4b223` | `#f4b223` | Primary fill, focus edges, dock sash, active tab line, editor cursor |
| `--mg-accent-text`  | `#f6be48` | `#8a5600` | Amber text: active segment, active explain tab, search matches       |
| `--mg-accent-hover` | `#ffc43d` | `#e9a511` | Unused, see Open items                                               |
| `--mg-accent-ink`   | `#1a1406` | `#1a1406` | Unused, see Open items                                               |
| `--mg-link`         | `#6aa5ff` | `#2563d6` | Info (blue)                                                          |
| `--mg-ok`           | `#4cc38a` | `#1e9e63` | Healthy (green)                                                      |
| `--mg-warn`         | `#f08a3c` | `#c2570c` | Slow or warning (orange)                                             |
| `--mg-danger`       | `#f2597f` | `#d4244e` | Error or destructive (rose)                                          |

Series and syntax:

| Token                                                          | Dark                                                             | Light                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `--mg-series-1` to `-6`                                        | `#6aa5ff`, `#f4b223`, `#f2597f`, `#a98bfa`, `#3cc9b5`, `#f08a3c` | `#2f6fdb`, `#d99100`, `#d4244e`, `#7b54d9`, `#12958a`, `#d4650e` |
| `--mg-code-key`, `-keyword`, `-string`, `-number`, `-function` | `#7fb0ff`, `#b79cfa`, `#8ed1a0`, `#f2a15f`, `#f4cf6b`            | `#2f6fdb`, `#7b54d9`, `#1e8a50`, `#c2570c`, `#8a5600`            |

`--mg-series-2`, `-3`, `-6` and `--mg-code-function` have no use. See Open items.

Shadows: `--mg-shadow` is `0 4px 12px` at 35% black in dark and 12% in light. `--mg-shadow-popup` is `0 10px 28px` at 60% in dark and 22% in light.

Dimmed text (`--mantine-color-dimmed`) and placeholders map to `--mg-text-muted`. Disabled button text and background use `--mg-text-muted` and `--mg-surface-3`.

### Mantine colour ladders

`theme.ts` overrides the colour ladders. Shade 6 is the solid colour. Shade 4 is the light shade for coloured text on dark.

| Name              | Shade 6   | Shade 4   | Use                                                                |
| ----------------- | --------- | --------- | ------------------------------------------------------------------ |
| `brand` (primary) | `#f4b223` | `#f6be48` | Filled buttons. Hover shade 7 `#ffc43d`, pressed shade 8 `#c98d0d` |
| `yellow`          | `#f4b223` | `#f6be48` | Busy and paused states                                             |
| `orange`          | `#f08a3c` | `#f49a5c` | Warnings                                                           |
| `red`             | `#f2597f` | `#f46d8d` | Errors and destructive actions                                     |
| `violet`          | `#a98bfa` | `#b295f9` | Update operations, neutral marker                                  |
| `blue`            | `#6aa5ff` | `#7cacff` | Info, running states                                               |
| `green`           | `#4cc38a` | `#63d199` | Healthy states, green badges                                       |
| `teal`            | `#3cc9b5` | `#57d3c3` | Connection colour swatch                                           |

The `dark` ladder: 0 `#f2f3f5` text, 2 `#9da0a8` dimmed, 3 `#7a7e85` placeholder and disabled, 4 `#393b40` borders, 5 `#34363b` default hover, 6 `#2b2d30` inputs and default buttons, 7 `#1e1f22` page, 8 `#25272a` segmented control track, 9 `#18191b`.

## Status and value colours

- Info is blue (`--mg-link`). Healthy is green (`--mg-ok`). Warning or slow is orange (`--mg-warn`). Error is rose (`--mg-danger`).
- Busy and paused states use Mantine yellow. See Open items.
- Log severity (`diagnostics/log-severity.ts`): fatal and error are red and tint the row. Warning is orange and tints the row. Info and debug are gray.
- Change stream operations (`changes/changes-model.ts`): insert blue, update violet, replace yellow, delete and dropDatabase red, drop and rename orange, others gray.
- Connection tree state dots (`connections/tree.css`) are 7px circles in Mantine blue, yellow, red, violet or gray. The default is `--mg-text-muted`.
- BSON value colours (`results/value-color.ts`): String `--mg-ok`. Int32, Int64, Double and Decimal128 `--mg-warn`. ObjectId `--mg-series-4`. Date `--mg-danger`. Null `--mg-text-faint`. Other types use the default text colour.
- Connection colours: eight swatches in `connections/ConnectionDialog.tsx`: `#6aa5ff #f4b223 #f2597f #4cc38a #a98bfa #3cc9b5 #f08a3c #a19d96`.

## Editor colours

`kit/code/editor-theme.ts` defines `mongo-gui-dark` (base `vs-dark`) and `mongo-gui-light` (base `vs`). Both inherit the stock theme.

Dark token colours (`DARK_COLORS`): property `#d0d0cd` (fields, keys, columns), type `#ab79ed` (collections, tables, ObjectId), function `#a9c7fb`, predefined `#fc559b` (operators, SQL built-ins), keyword `#7bacf9` (keywords, true, false, null), string `#fcd15a`, number `#f98d58`, comment `#9fa1a2` (italic). These predate Graphite. See Open items.

Light token colours are the VS Code light defaults (`LIGHT_COLORS`). The light colour map is empty, so the stock surfaces apply.

Dark surfaces (`DARK_EDITOR_COLORS`): background `#18191b`, foreground `#f2f3f5`, current line `#25272a`, selection `#2e436e`, inactive selection `#2b2d30`, cursor `#f4b223`, line numbers `#7a7e85` (active `#dfe1e5`), widgets and suggest list `#2b2d30` with border `#393b40`, scrollbar slider `#393b4099` (hover `#34363b`).

The editors use `CODE_FONT` (Geist Mono).

## Chart colours

`theme/palette.ts` gives each scheme a series order, a card surface and four ink colours.

- Dark series: `#6aa5ff #f4b223 #f2597f #a98bfa #f08a3c #3cc9b5 #4cc38a #f6be48`. Card `#1e1f22`. Gridline `#2b2d30`. Baseline `#393b40`. Ink `#f2f3f5`, `#dfe1e5`, `#9da0a8`.
- Light series: `#2a78d6 #eb6834 #1baf7a #eda100 #e87ba4 #008300 #4a3aa7 #e34948`. Card `#fcfcfb`. Gridline `#e1e0d9`. Baseline `#c3c2b7`. Ink `#0b0b0b`, `#52514e`, `#898781`.
- Series wrap after the eighth colour. The light series sit below 3:1 on the light card, so readouts carry the identity too (palette.ts comment).

## Typography

- UI text, tables and labels use Geist Variable (`UI_FONT`). `TABLE_FONT` is the same font. Code uses Geist Mono Variable (`CODE_FONT`). Both ship as `@fontsource-variable` packages imported in `theme/theme.ts:1-2`. Nothing loads from the network.
- Weights: headings 600, buttons 500, badges 600 with `letter-spacing: 0.02em`, input labels 12px muted at 400, body 400 (Mantine default). Modal titles are 18px at 600 with `letter-spacing: -0.01em`.
- The theme sets no `fontSizes`. The root font size is `16px * scale`, where `scale` is the editor font size divided by 13 (`theme/font-scale.ts`). Custom pixel sizes multiply by `--mg-font-scale`, for example the connection tree labels at `12.5px` (`connections/tree.css:4`), tree messages at `11.5px` (`tree.css:181`) and dock tab text at `12px` (`theme/dockview-theme.css:14`).

## Spacing, radius and elevation

- Spacing scale: xs 4px, sm 8px, md 12px, lg 16px, xl 24px (`theme.ts`). Mantine `gap`, `p` and `m` props use these.
- Radius: xs 2px (tree rows), sm 4px (fieldsets), md 6px (default), lg 10px (modals), xl 999px (pill badges and tree count chips). Dockview uses 0.
- Popups (Menu, Popover, Combobox) have a 1px `--mg-border-strong` outline, the `--mg-surface-2` background and `--mg-shadow-popup`.
- Modals have no shadow. The backdrop is `#18191b` at 70% opacity.
- Layers step by surface colour: page `surface-0`, sidebar `--mg-side`, modal `surface-1`, popups `surface-2`.
- Tree density: rows are 28px * scale, or 32px * scale with `data-density='comfortable'` (`connections/tree.css:9-17`).

Row heights are per component, with no token: results grid 28px, profiler slow queries 32px, change events 30px, schema fields 44px.

## Components

### Buttons

- `Button` defaults to `size="xs"` with font weight 500. `ActionIcon` defaults to `size="sm"` and `variant="subtle"`.
- Primary is a filled button with no `variant`. Fill `#f4b223`, hover `#ffc43d`, pressed `#c98d0d`, text `#1e1f22`.
- Secondary is `variant="default"`, which uses the input colour.
- Destructive is `color="red"`. `ConfirmDialog` defaults to red.
- Disabled: `--mg-surface-3` background, `--mg-border` outline, `--mg-text-muted` text (`tokens.css:108-113`).

### Inputs and toggles

- `TextInput`, `Textarea`, `PasswordInput`, `NumberInput`, `ColorInput`, `Select`, `SegmentedControl`, `Switch` and `Checkbox` default to `size="xs"`.
- Input background `--mg-surface-2`, outline `--mg-border-strong`, text `--mg-text-strong`. Placeholders use `--mg-text-muted`. Labels are 12px `--mg-text-muted` with 4px below.

### Popups and menus

- Menu, Popover and Combobox use the popup style in `theme.ts`. Menu dividers use `--mg-border-strong`.

### Tabs and dock

- Dock tab strip: 32px * scale tall, 12px * scale text, `--mg-bg-sunken` background.
- Active tab: `--mg-surface-0` background, `--mg-text-strong` text, 2px `--mg-accent` line on top. Inactive tab: `--mg-surface-1` background, `--mg-text-muted` text, 1px `--mg-border-strong` separator on the right.
- Tabs are 40px to 200px wide. The active tab is at least 140px.
- Dock sash: `--mg-surface-2` at rest, `--mg-accent` when active. Dock context menu: `--mg-surface-1` background, `--mg-text-strong` text.
- Mantine `Tabs` have no theme override.

### Dialogs

- `Modal` defaults: radius `lg` (10px), padding `xl` (24px), content and header `--mg-surface-1`, 1px `--mg-border-strong` outline. The header has 8px below it.
- Width is set per dialog. `ConfirmDialog` uses 440px.
- `ConfirmDialog` (`kit/ConfirmDialog.tsx`) is the standard layout: centred, a `Stack` with 8px gaps, a 14px description, an optional text field labelled "Type {name} to confirm", an error in a red light `Alert`, and a right-aligned footer with Cancel (`variant="default"`) and the confirm button last. The confirm button stays disabled until the typed text matches, shows `loading` while the action runs, and keeps the dialog open with the error on failure.

### Notifications

- `Notifications` sits at `bottom-right` (`theme/AppProviders.tsx`).
- `notifyError` (`kit/notify-error.ts`) shows a red notification. The default title is "Something went wrong". `runReported` wraps an action and reports its error.
- No shared success or loading helper exists.

### Trees

- Connection tree (`connections/tree.css`): labels 12.5px * scale at line height 1.3 in `--mg-text`. Hover `--mg-hover`. Selected: `--mg-surface-2` background, `--mg-text-strong` text, 1px `--mg-border-strong` outline. Keyboard focus: 1px `--mg-accent` outline, inset by 1px.
- Tree search box: 30px tall, `--mg-surface-2`, `--mg-border-strong` outline. Focus gives an accent outline. Matches are `--mg-accent-text` on 22% accent.
- Result tree (`results/TreeView.tsx`): 28px * scale rows.

### Tables

- The AG Grid results table (`results/TableView.tsx`) and `storage/StorageTable.tsx` set a dark theme with hard-coded hex: background `#18191b`, text `#f2f3f5`, header `#2b2d30` with text `#dfe1e5`, border `#393b40`, row hover `#2b2d30`, selected row `#2e436e`, accent `#f4b223`, chrome `#2b2d30`. The font is `TABLE_FONT`. The copies do not read tokens. See Open items.
- Management tables use Mantine `Table`. Header background is `--mg-surface-3` (`theme.ts`).
- Profiler grid: header on the body colour with a 1px `--mg-border` bottom edge. Row hover `--mg-surface-1`. Selected row is an accent tint at 14%. New rows flash `--mantine-color-yellow-light` and fade over 1.5s. Slow durations use `--mg-warn`, very slow ones `--mg-danger`.

## States

- Hover: `--mg-hover` on tree rows. Other controls use Mantine's default. The primary fill goes to shade 7.
- Pressed: primary fill goes to shade 8.
- Selected: tree rows use `--mg-surface-2`. Grid rows use `#2e436e`. Profiler rows use the accent tint.
- Focus: tree rows use a 1px accent outline. The profiler scroller uses an inset 1px accent ring. Explain rows use a 2px accent outline. Explain nodes use a 2px `blue-5` outline. Other controls use Mantine's focus ring.
- Disabled: see Buttons. Other controls use Mantine's default.
- Error: a red light `Alert` or a red notification. Tree messages use `--mantine-color-error`.
- Empty: dimmed text. No shared empty-state component exists.

## Rules

- Take colours from tokens. Do not write hex values into components. The exceptions are listed under Open items.
- Amber marks the primary action and the active state. Use one filled primary button per view.
- Text on the primary fill is `#1e1f22`.
- A status has a word or an icon, not colour alone.
- Text needs 4.5:1 contrast on its surface. Icons, dots and borders need 3:1 (WCAG).
- Dark is the default. The setting chooses light.

## Open items

- Remove `@fontsource-variable/inter`, `@fontsource-variable/manrope` and `@fontsource/jetbrains-mono` from `packages/ui/package.json`. No source file imports them.
- `kit/code/editor-theme.ts:114-124` loads the JetBrains Mono faces before it remeasures Monaco. Load `CODE_FONT` (Geist Mono) instead.
- Hard-coded colours that do not read tokens: the Monaco dark token colours (`editor-theme.ts:37-46`) predate Graphite. The AG Grid theme copies hex values into `TableView.tsx` and `StorageTable.tsx`.
- `theme/palette.ts` chart colours differ from the `--mg-series-*` tokens: dark slots 5 and 6, and every light slot.
- Unused tokens: `--mg-selected`, `--mg-selected-text`, `--mg-accent-hover`, `--mg-accent-ink`, `--mg-series-2`, `--mg-series-3`, `--mg-series-6` and `--mg-code-function`. Remove them or use them.
- Mantine yellow is the busy colour, and it is the same hue as the primary. Paused tree states and `replace` operations use it. Decide whether status yellow stays.
- Focus rings differ by component: tree accent, explain nodes `blue-5` (`explain/explain.css:407`), profiler accent inset. Pick one.
- Selected rows differ by component: tree `--mg-surface-2`, grid `#2e436e`, profiler accent tint.
- About 20 call sites use `gap={4}` or `gap={6}`, for example `replication/ReplicationPanel.tsx:245` and `profiler/ProfilerDetail.tsx:152`. Move them to the spacing scale or add a 6px step.
- Share bars behind Top time cells (`docs/ui-guidelines.md`) are not built.
- Not built: auto-lock toggle on first run; query history count in the connection manager; storage engine and created date in the collection subtitle; collapse chevron in the output panel header (`editor/OutputPanel.tsx` has none); Expand all and Collapse all in the Table view (only `results/TreeView.tsx` has them).
- Not checked in a browser: the monitor layout (dragging headers and dividers), the light theme on every screen, the Add panel badge contrast (`--mg-text-muted` on `--mg-hover` is 4.54:1 in light), the search footer and chips, and search on the 500-database instance (`dev/many-collections/up.sh`).
- A recreated Docker container gets a new id. Its connection is removed, and its name, colour and history go with it. Decide whether to match by container name.
