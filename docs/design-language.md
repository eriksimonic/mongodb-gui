# Design language inventory

This file lists the design language as the code defines it today. It describes what exists, not what should exist. Where the code and `docs/color-palette.md` or `docs/ui-guidelines.md` disagree, section 14 says so.

All paths are relative to `packages/ui/src` unless they start with `docs/`. The UI is built on Mantine 8 (`@mantine/core ^8.3.18`), Tabler icons, dockview for panels, AG Grid for the results table, uPlot for charts and Monaco for editors.

Central definition files:

| File                       | Defines                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `theme/theme.ts`           | Mantine theme: colour ladders, fonts, radius, spacing, component defaults |
| `theme/tokens.css`         | `--mg-*` surface and text variables for dark and light                    |
| `theme/palette.ts`         | Chart series colours and chart ink, dark and light                        |
| `theme/dockview-theme.css` | Dockview variables mapped to `--mg-*`                                     |
| `theme/font-scale.ts`      | `--mg-font-scale`, driven by the editor font size setting                 |
| `kit/code/editor-theme.ts` | Monaco themes `mongo-gui-dark` and `mongo-gui-light`                      |
| `theme/AppProviders.tsx`   | `MantineProvider`, `ModalsProvider`, `Notifications` host                 |

## 1. Color tokens

There is a dark theme and a light theme. `AppProviders.tsx:25` takes a `colorScheme` prop (default `'dark'`) and passes it as `forceColorScheme`, so the app follows the setting and not the OS. The dark theme is fully specified. The light theme is a thin layer over Mantine's default greys (`theme/tokens.css:34-48`), plus a separate chart palette and a VS Code style Monaco theme.

### Surfaces and borders

| Token (`theme/tokens.css`) | Dark                          | Light                         | Line    |
| -------------------------- | ----------------------------- | ----------------------------- | ------- |
| `--mg-bg-sunken`           | `#0a0a0c`                     | Mantine white                 | 12 / 35 |
| `--mg-surface-0`           | `#0f0f11`                     | Mantine white                 | 13 / 36 |
| `--mg-surface-1`           | `#18181b`                     | Mantine gray-1                | 14 / 37 |
| `--mg-surface-2`           | `#222226`                     | Mantine gray-2                | 15 / 38 |
| `--mg-surface-3`           | `#2a2a2f`                     | Mantine gray-1                | 16 / 39 |
| `--mg-border`              | `#34343a`                     | Mantine gray-3                | 17 / 40 |
| `--mg-hover`               | `#3a3a40`                     | Mantine gray-1                | 18 / 41 |
| `--mg-selected`            | `#3d3317`                     | Mantine gray-3                | 19 / 42 |
| `--mg-shadow`              | `0 4px 12px rgb(0 0 0 / 35%)` | `0 4px 12px rgb(0 0 0 / 12%)` | 22 / 46 |

The Mantine `dark` ladder in `theme/theme.ts:99-110` repeats the same hex values by index: 0 `#f5f3ee` text, 1 `#d0d0cd`, 2 `#9fa1a2` dimmed, 3 `#6e7276` placeholder and disabled, 4 `#34343a` borders, 5 `#3a3a40` default hover, 6 `#2a2a2f` inputs and default buttons, 7 `#0f0f11` page, 8 `#18181b`, 9 `#0a0a0c`. Light surfaces come from Mantine's stock gray ladder and are not set in `theme.ts`.

### Text

| Token                | Dark                                                                  | Light           | Line                                                            |
| -------------------- | --------------------------------------------------------------------- | --------------- | --------------------------------------------------------------- |
| `--mg-text`          | `#d0d0cd`                                                             | Mantine gray-7  | 20 / 43                                                         |
| `--mg-text-strong`   | `#f5f3ee`                                                             | Mantine gray-9  | 21 / 44                                                         |
| `--mg-text-muted`    | `#9fa1a2`                                                             | Mantine gray-6  | 23 / 45                                                         |
| `--mg-selected-text` | `#f5f3ee`                                                             | Mantine gray-9  | 26 / 49                                                         |
| Disabled text        | `#6e7276` (Mantine `dark.3`, `theme/theme.ts:105`)                    | Mantine default | no `--mg-` token                                                |
| Dimmed text          | `var(--mantine-color-dimmed)`, resolves to `dark.2` `#9fa1a2` in dark | Mantine default | used in about 8 CSS rules, for example `explain/explain.css:54` |

Note the naming: the docs call `#f5f3ee` "text" and `#d0d0cd` "text-muted", while the CSS variables call `#d0d0cd` `--mg-text` and `#f5f3ee` `--mg-text-strong`.

### Accent

| Token                | Dark                                                      | Light              | Line                                                   |
| -------------------- | --------------------------------------------------------- | ------------------ | ------------------------------------------------------ |
| `--mg-accent`        | `#ffd60a`                                                 | Mantine blue-6     | `theme/tokens.css:24` / 47                             |
| `--mg-accent-text`   | `#ffd60a`                                                 | Mantine blue-7     | 25 / 48                                                |
| Primary (`brand[6]`) | `#ffc300`                                                 | same, both schemes | `theme/theme.ts:11-22`, `primaryColor: 'brand'` at 117 |
| Primary hover        | `#ffd60a` (`brand[7]`)                                    | same               | `theme/theme.ts:19`                                    |
| Primary pressed      | `#e0ad02` (`brand[8]`)                                    | same               | `theme/theme.ts:20`                                    |
| Text on primary      | `#0f0f11` via `black: '#0f0f11'` and `autoContrast: true` | same               | `theme/theme.ts:121,119`                               |

The light theme uses Mantine blue as its accent, not yellow, in the `--mg-accent` variables. Filled Mantine buttons still use the yellow `brand` primary in both schemes.

### Status colors

The theme overrides Mantine's `blue`, `yellow`, `orange`, `red` and `violet` ladders (`theme/theme.ts:23-97`). Shade 6 is the solid colour and shade 4 is the light shade used for text in the dark scheme. The same ladder is used in both schemes.

| Status  | Mantine name | Solid (6) | Light text (4) | Where defined          |
| ------- | ------------ | --------- | -------------- | ---------------------- |
| OK      | `blue`       | `#3a86ff` | `#7bacf9`      | `theme/theme.ts:81-92` |
| Busy    | `yellow`     | `#ffbe0b` | `#fcd15a`      | `theme/theme.ts:35-46` |
| Warning | `orange`     | `#fb5607` | `#f98d58`      | `theme/theme.ts:47-58` |
| Error   | `red`        | `#ff006e` | `#fc559b`      | `theme/theme.ts:59-70` |
| Marker  | `violet`     | `#8338ec` | `#ab79ed`      | `theme/theme.ts:71-80` |

The row tints (`#141d2e`, `#2c2410`, `#2b1810`, `#2c0d1c`, `#1d142b`) listed in `docs/color-palette.md` are not defined in code. Mantine's `light` variants (`var(--mantine-color-red-light)` and so on) take their place. `luminanceThreshold: 0.2` (`theme/theme.ts:121`) decides which solids get white text; only violet does.

Other colour definitions that are not part of the theme:

| Value                                             | Where                                 | Use                        |
| ------------------------------------------------- | ------------------------------------- | -------------------------- |
| `#3a86ff #ffbe0b #fb5607 #ff006e #8338ec #9fa1a2` | `connections/ConnectionDialog.tsx:31` | Connection colour swatches |
| `#3a86ff`, `#ffbe0b`                              | `api/mock-fixtures.ts:22,32`          | Mock data only             |

## 2. Typography

Three font stacks are defined in `theme/theme.ts:9-14`. The fonts ship with the app through `@fontsource` packages (`theme/theme.ts:1-5`), so nothing loads from the network.

| Constant     | Stack                                                        | Used for                                                                  | Line |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------- | ---- |
| `UI_FONT`    | `"Manrope Variable", system-ui, "Segoe UI", sans-serif`      | Labels, buttons, menus, headings (`fontFamily` and `headings.fontFamily`) | 12   |
| `TABLE_FONT` | `"Inter Variable", system-ui, "Segoe UI", sans-serif`        | Mantine `Table` and the AG Grid results table                             | 14   |
| `CODE_FONT`  | `"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace` | Monaco editors, uPlot axis labels, `fontFamilyMonospace`                  | 10   |

`APP_FONT` does not exist in the code. The JetBrains Mono faces loaded are 400, 400 italic and 600 (`theme/theme.ts:3-5`). `docs/color-palette.md` says JetBrains Mono is used for all text, which is no longer true (section 14).

### Size scale

The theme sets no `fontSizes` or `lineHeights`, so Mantine 8 defaults apply to `size="xs|sm|md"` props. Those defaults are rem based. The root font size is `16px * scale` (`theme/font-scale.ts:25`), where `scale = editorFontSize / 13` and 13 is the base editor font size (`theme/font-scale.ts:5`). Custom CSS multiplies pixel sizes by `--mg-font-scale`.

| Size in code                  | Where                                                                                                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11px x scale                  | Tree meta (`connections/tree.css:73`), chart tooltip hints, explain captions (`explain/explain.css:55`)                                                                                                                     |
| 11.5px x scale                | Tree message lines (`connections/tree.css:126`)                                                                                                                                                                             |
| 12px x scale                  | Dockview tab text (`theme/dockview-theme.css:14`), chart tooltip (`monitor/monitor.css:20`), chips (`monitor/monitor.css:62`), schema table (`schema/SchemaFieldTable.tsx:53`), output panel (`editor/OutputPanel.tsx:114`) |
| 12.5px x scale                | Connection tree body (`connections/tree.css:4`)                                                                                                                                                                             |
| 13px x scale                  | Result tree rows (`results/TreeView.tsx:296`), explain panel (`explain/explain.css:5`)                                                                                                                                      |
| `var(--mantine-font-size-xs)` | Profiler grid (`profiler/profiler.css:7`)                                                                                                                                                                                   |
| 11px, unscaled                | uPlot axis labels (`monitor/UPlotChart.tsx:28`)                                                                                                                                                                             |
| Editor font size              | Monaco, from the `editorFontSize` setting (`editor/MongoshMonaco.tsx:73`, `kit/code/ReadOnlyMonaco.tsx:18`)                                                                                                                 |

### Weights and line heights

| Item                              | Value                        | Where                                                |
| --------------------------------- | ---------------------------- | ---------------------------------------------------- |
| Headings                          | 600                          | `theme/theme.ts:127`                                 |
| Chart values, very slow durations | 600                          | `monitor/monitor.css:54`, `profiler/profiler.css:87` |
| Body weight                       | 400, Mantine default         | not set                                              |
| Tree line height                  | 1.3 (messages 1.4)           | `connections/tree.css:5,127`                         |
| Chart tooltip                     | 1.5                          | `monitor/monitor.css:21`                             |
| Everything else                   | Mantine default line heights | not set                                              |

Numbers in charts use `font-variant-numeric: tabular-nums` (`monitor/monitor.css:55,90`). Result cells for ObjectId and right-aligned numbers use `var(--mantine-font-family-monospace)` (`results/TableView.tsx:60-62`).

## 3. Spacing, density, radius, elevation, icons

### Spacing

Defined in `theme/theme.ts:128`.

| Key  | Value |
| ---- | ----- |
| `xs` | 4px   |
| `sm` | 6px   |
| `md` | 10px  |
| `lg` | 14px  |
| `xl` | 20px  |

Mantine's default pixel spacing is replaced, so `gap="sm"` is 6px. Custom CSS uses plain pixel values (4, 6, 8, 14, 16) and `var(--mantine-spacing-sm)` in `monitor/monitor.css:97,113`.

### Density

There is one density control: the connection tree has `data-density='comfortable'` (32px rows) versus the default (28px rows), in `connections/tree.css:9-17`. Other lists have fixed heights. Row heights per component are in sections 7 and 8.

### Radius

| Item                                 | Value                                    | Where                         |
| ------------------------------------ | ---------------------------------------- | ----------------------------- |
| `radius.sm`                          | 4px, also `defaultRadius: 'sm'`          | `theme/theme.ts:124-125`      |
| `radius.md`                          | 6px, used by `Modal`                     | `theme/theme.ts:125,150`      |
| Mantine `xs`                         | Mantine default (2px), used by tree rows | `connections/tree.css:18`     |
| Dockview radius                      | 0                                        | `theme/dockview-theme.css:34` |
| Explicit `radius="sm"` on components | 17 uses                                  | various `.tsx`                |

### Elevation

The theme defines no shadows. Overlays rely on a 70% dark backdrop for modals (`theme/theme.ts:150`, `overlayProps.backgroundOpacity: 0.7`, colour `#0f0f11`). The context menu uses `shadow="md"` (`kit/TreeMenu.tsx:28`). The chart tooltip uses a box shadow (`monitor/monitor.css:19`, see section 14). `--mg-shadow` is defined in `theme/tokens.css:22`.

Layers step by surface colour: page `surface-0`, sidebar and tab bars `surface-1`, popups and modals `surface-2` (`theme/theme.ts:136`, `theme/theme.ts:151-152`), inputs and table headers `surface-3`.

### Icons

| Item                | Value                                                                              | Where                              |
| ------------------- | ---------------------------------------------------------------------------------- | ---------------------------------- |
| Library             | `@tabler/icons-react ^3.49.0`                                                      | `packages/ui/package.json:26`      |
| Stroke              | Not set. Tabler's default stroke (1.5) applies, no `stroke=` prop is used anywhere | grep result                        |
| Sizes in use        | 14 (82 uses), 16 (19), 12 (19), 13 (8), 18 (1), 22 (1)                             | `<Icon... size={n}>` across `.tsx` |
| Tree icons          | 14px box with 6px right margin; chevron 14px with 4px margin                       | `connections/tree.css:39-57`       |
| Result tree chevron | Text glyphs `▾` and `▸`, not an icon                                               | `results/TreeView.tsx:309`         |

No central icon size constant or wrapper exists.

## 4. Buttons

Defaults in `theme/theme.ts:131-132`: `Button` is `size="xs"`, `ActionIcon` is `size="sm"` with `variant="subtle"`. There is no shared button component in `kit/`.

| Variant (Mantine) | Count in code                                            | Typical use                                                         |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| `default`         | 142 (all components, includes `Badge`, `Button`, `Tabs`) | Secondary buttons: input grey (`dark.6`) with off-white text        |
| `light`           | 125                                                      | Badges, alerts, tinted buttons                                      |
| `subtle`          | 46                                                       | Icon buttons, toolbar actions                                       |
| `outline`         | 8                                                        | Rare                                                                |
| `filled`          | 5                                                        | Primary actions and some badges (`profiler/ProfilerDetail.tsx:161`) |

The count column covers every `variant="..."` prop, so it includes non-button components. A filled button with no variant is the yellow primary (`#ffc300`, hover `#ffd60a`, pressed `#e0ad02`, text `#0f0f11`).

| State       | Behaviour                                                                   | Source                     |
| ----------- | --------------------------------------------------------------------------- | -------------------------- |
| Hover       | Mantine default; primary goes to `brand[7]` `#ffd60a`                       | `theme/theme.ts:19`        |
| Pressed     | `brand[8]` `#e0ad02`                                                        | `theme/theme.ts:20`        |
| Loading     | `loading` prop on `Button`, for example `kit/ConfirmDialog.tsx:78`          | Mantine                    |
| Disabled    | `disabled` prop, Mantine styling; text uses `dark.3`                        | Mantine                    |
| Destructive | `color="red"` filled button, `ConfirmDialog` default `confirmColor = 'red'` | `kit/ConfirmDialog.tsx:29` |

Sizes: 26 `Button` uses set `size="xs"` explicitly, which equals the default. No other button size appears.

## 5. Inputs, selects, toggles, tabs, menus, tooltips, toasts, badges, splitters, scrollbars

### Inputs, selects and toggles

`TextInput`, `Textarea`, `PasswordInput`, `NumberInput`, `ColorInput`, `Select`, `SegmentedControl`, `Switch` and `Checkbox` all default to `size="xs"` (`theme/theme.ts:133-142`). Input fill is `dark.6` `#2a2a2f` and the border is `dark.4` `#34343a`, from the Mantine dark ladder. Dropdowns of `Menu`, `Popover` and `Combobox` use `var(--mg-surface-2)` (`theme/theme.ts:136,145-147`). `Fieldset` has `radius="sm"`. Focus, error and disabled styling are Mantine defaults.

### Tabs

`Tabs` has no theme override. Orientations in use: two vertical (settings and similar), one horizontal (profiler, `profiler/ProfilerPanel.tsx:154`). Mantine's default variant applies. Panel tabs are dockview tabs, styled in `theme/dockview-theme.css`:

| Item                  | Value                                            | Line  |
| --------------------- | ------------------------------------------------ | ----- |
| Tab bar height        | 28px x scale                                     | 13    |
| Tab bar background    | `--mg-surface-1`                                 | 12    |
| Active tab background | `--mg-surface-0` in the active group             | 15    |
| Active tab text       | `--mg-text-strong`                               | 19    |
| Inactive tab text     | `--mg-text-muted`                                | 21-22 |
| Tab width             | min 40px, max 200px; the active tab is min 140px | 47-57 |

### Menus and context menus

Menus use Mantine `Menu`. The context menu is `kit/TreeMenu.tsx`: `Menu` with `position="bottom-start"`, `shadow="md"`, `width={200}` (line 28), entry kinds item, divider and submenu, optional `color` per item (line 10), and a disabled `reason` text. Dockview's own context menu uses `--mg-surface-1` background and `--mg-text-strong` text (`theme/dockview-theme.css:31-32`).

### Tooltips

Mantine `Tooltip`, no theme default. 21 uses set `withArrow`. `InfoTip` (`kit/InfoTip.tsx`) is the shared help icon. Delay and position are Mantine defaults.

### Toasts

`<Notifications position="bottom-right" />` (`theme/AppProviders.tsx:33`). There is no shared toast helper except `notifyError` in `kit/notify-error.ts:23`, which shows `color: 'red'` with title "Something went wrong" by default. Success toasts use `color: 'blue'` (for example `profiler/ProfilerDetail.tsx:144`). One call sets `autoClose: 1500`. Loading toasts are described in `docs/ui-guidelines.md` but have no central helper.

### Badges and tags

Mantine `Badge`, no theme default. The usual call is `tt="none" variant="light" size="xs|sm" color="gray|blue|red|orange"` (`profiler/SlowQueryTable.tsx:297-370`, `results/ResultsPane.tsx:223`). `operationColor` in `changes/changes-model.ts:134-150` maps change stream operations to colours. Docker connection states are 7px dots (`connections/tree.css:82-117`).

### Splitters

| Splitter                 | Value                                                                                          | Where                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Dockview sash            | Rest `--mg-surface-2`, active `--mg-accent`                                                    | `theme/dockview-theme.css:27-28`                                 |
| Profiler detail splitter | 6px wide, `col-resize`, 1px left border `--mg-border`, focus fill `blue-5`, keyboard step 24px | `profiler/profiler.css:90-100`, `profiler/ProfilerDetail.tsx:20` |

### Scrollbars

No custom scrollbar CSS exists in any `.css` file. Browser and Chromium defaults apply to plain `overflow: auto` boxes. Monaco scrollbar sliders are themed (`kit/code/editor-theme.ts:91-92`). Mantine `ScrollArea` is used in 4 files (`tools/ToolsLicenceModal.tsx`, `connections/ConnectionManager.tsx`, `backup/BackupProgressView.tsx`, `results/TableView.tsx`).

## 6. Dialogs

Dialogs use Mantine `Modal`. Theme defaults (`theme/theme.ts:148-155`): `radius: 'md'` (6px), overlay `#0f0f11` at 70% opacity, content and header background `--mg-surface-2`. No shadow.

| Size prop | Count | Meaning in Mantine 8 |
| --------- | ----- | -------------------- |
| `sm`      | 9     | 380px                |
| `md`      | 3     | 440px                |
| `lg`      | 8     | 620px                |
| `xl`      | 2     | 780px                |
| `{640}`   | 1     | 640px                |

`docs/ui-guidelines.md` allows data-heavy dialogs up to 1100px or 94% of the window. No size constant is shared.

### Layout

Every dialog lays out its own body. The pattern in `kit/ConfirmDialog.tsx:53-85` is the closest thing to a standard: `Modal` with `centered`, `size="sm"`, `Stack gap="sm"`, a `Text size="sm"` description, an optional input, an optional red `Alert variant="light"` for errors, and a `Group justify="flex-end"` footer with a `variant="default"` Cancel button first and the confirm button last. The title sits in the Mantine modal header with a close button.

### Destructive confirm pattern

- `ConfirmDialog` (`kit/ConfirmDialog.tsx:23`) takes `confirmColor` (default `'red'`), `typedConfirmation` and `confirmDisabled`.
- A drop passes `typedConfirmation`, which adds a `TextInput` labelled "Type {name} to confirm" (line 58). The confirm button stays disabled until the text matches exactly (line 36).
- Other destructive actions pass no `typedConfirmation`, and the description states what gets deleted.
- The confirm button shows `loading` while the promise runs. A failure shows in the red alert and keeps the dialog open (lines 43-47).
- Settings use a vertical tab layout with fixed width and panel height (`settings/SettingsModal.tsx`).

## 7. Table and grid

There are four table implementations. No shared table component exists in `kit/`.

| Table                 | Implementation         | Row height                     | Header height                    | File                                                          |
| --------------------- | ---------------------- | ------------------------------ | -------------------------------- | ------------------------------------------------------------- |
| Results table         | AG Grid (Quartz theme) | 28px                           | 32px (row + 4)                   | `results/TableView.tsx:67,178-179`                            |
| Profiler slow queries | Virtual CSS grid       | 32px                           | 32px                             | `profiler/SlowQueryTable.tsx:19,21`                           |
| Result tree           | Virtual CSS grid       | 28px x scale                   | none                             | `results/TreeView.tsx:50,124`                                 |
| Change events         | Virtual list           | 30px                           | none                             | `changes/ChangesPanel.tsx:36`                                 |
| Schema fields         | Virtual list           | 44px                           | n/a                              | `schema/SchemaFieldTable.tsx:41`                              |
| History               | Virtual list           | 52px                           | n/a                              | `editor/HistoryPanel.tsx:22`                                  |
| Management tables     | Mantine `Table`        | Mantine `verticalSpacing="xs"` | `th` background `--mg-surface-3` | `management/IndexesPanel.tsx:239`, `security/UsersTab.tsx:70` |

### Results table (AG Grid)

| Property          | Value                                                            | Line                       |
| ----------------- | ---------------------------------------------------------------- | -------------------------- |
| Font              | `TABLE_FONT` (Inter Variable)                                    | `results/TableView.tsx:50` |
| Background        | `#0a0a0c`                                                        | 51                         |
| Foreground        | `#f5f3ee`                                                        | 52                         |
| Header background | `#222226`                                                        | 53                         |
| Header text       | `#d0d0cd`                                                        | 54                         |
| Border            | `#34343a`                                                        | 55                         |
| Row hover         | `#222226`                                                        | 56                         |
| Selected row      | `#3d3317`                                                        | 57                         |
| Accent            | `#ffd60a`                                                        | 58                         |
| Chrome background | `#222226`                                                        | 59                         |
| Selection         | `rowSelection: { mode: 'multiRow', enableClickSelection: true }` | 180                        |
| Columns           | `resizable: true`                                                | 121                        |
| Light theme       | stock `themeQuartz` with `colorSchemeLight` and `TABLE_FONT`     | 61                         |

These hex values are hard-coded copies of the tokens. They do not read CSS variables.

### Profiler grid

Header sticks to the top inside the scroller, background `--mantine-color-body`, 1px bottom border `--mg-border` (`profiler/profiler.css:24-30`). Rows are absolutely positioned, 1px bottom border `--mg-surface-1`, hover `--mg-surface-1`, selected `--mantine-color-blue-light` (`profiler/profiler.css:32-47`). Column gap is 6px and horizontal padding is 8px (16px grid padding in `SlowQueryTable.tsx:24`).

### Zebra, selection and cell formats

- Zebra: Mantine `Table striped` in 7 management and transfer tables (`management/IndexesPanel.tsx:239`, `security/UsersTab.tsx:70`, `management/DocumentsPanel.tsx:171`, `sharding/DistributionDialog.tsx:58`, `transfers/TransferProgressView.tsx:93`). The results table, profiler and trees have no zebra.
- Cell formats: right-aligned monospace for numbers, monospace for ObjectId, dimmed for null, one line with ellipsis and the full value in `title` (`results/TableView.tsx:57-90`, `profiler/profiler.css:62-68`). Slow durations use `orange-text` and very slow ones `red-text` at weight 600 (thresholds are in the profiler model, not checked here) (`profiler/profiler.css:81-88`).
- Pixel widths of profiler columns are per-column constants (`profiler/SlowQueryTable.tsx:31-40`) scaled by `--mg-font-scale`.

## 8. Tree views

### Connection tree (`connections/tree.css`)

| Property     | Value                                                                                                                                                                  | Line    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Font size    | 12.5px x scale, line height 1.3, colour `--mg-text`                                                                                                                    | 4-6     |
| Row height   | 28px x scale; 32px x scale when `data-density='comfortable'`                                                                                                           | 9-17    |
| Indent       | 16px per depth, labels start at depth x 16 + 42px (comment, line 1)                                                                                                    | 1       |
| Chevron      | 14px box, 4px right margin                                                                                                                                             | 39-48   |
| Icon         | 14px box, 6px right margin                                                                                                                                             | 50-57   |
| Row radius   | `--mantine-radius-xs`                                                                                                                                                  | 18      |
| Hover        | `--mg-hover`                                                                                                                                                           | 25-27   |
| Selected     | `--mg-selected` background, `--mg-selected-text` colour                                                                                                                | 29-32   |
| Focus        | 1px solid `--mg-accent`, offset -1px                                                                                                                                   | 34-37   |
| State dot    | 7px circle; running and primary `blue-6`, paused and restarting `yellow-6`, exited and down `red-6`, secondary `violet-6`, arbiter `gray-5`, default `--mg-text-muted` | 82-117  |
| Message rows | 11.5px x scale, `--mantine-color-dimmed`, error tone `--mantine-color-error`                                                                                           | 124-135 |
| Find bar     | Sticky, padding 4px 8px, `--mantine-color-body`, 1px bottom border                                                                                                     | 137-144 |

### Result tree (`results/TreeView.tsx`)

| Property         | Value                                                                     | Line    |
| ---------------- | ------------------------------------------------------------------------- | ------- |
| Row height       | 28px x scale                                                              | 50, 124 |
| Indent           | 16px per depth                                                            | 51, 294 |
| Columns          | `minmax(160px, 1fr) minmax(160px, 2fr) 90px 96px`, gap 8px                | 292-293 |
| Row border       | 1px `--mantine-color-dark-5`                                              | 295     |
| Expand glyph     | Text `▾` and `▸` in an `ActionIcon size="xs" variant="subtle"`            | 301-309 |
| Row actions      | Tabler icons at 13px (copy, clipboard, pencil, trash) and 14px (check, x) | 358-435 |
| Hover, selection | None defined. Rows have no hover or selected background.                  | not set |

## 9. Value colors and diff colors

### Editor and JSON text (Monaco)

See section 12. The editor colours match `docs/color-palette.md`.

### Results table cells

Cell colour comes from `typeColor(typeBucket(type), scheme)` (`schema/schema-model.ts:263-266`), which indexes the chart palette by the position of the type in `TYPE_SLOTS` (`schema/schema-model.ts:245-254`).

| BSON type | Slot | Dark color                | Light color |
| --------- | ---- | ------------------------- | ----------- |
| String    | 0    | `#3a86ff`                 | `#2a78d6`   |
| Int32     | 1    | `#ffbe0b`                 | `#eb6834`   |
| Double    | 2    | `#ff006e`                 | `#1baf7a`   |
| Boolean   | 3    | `#ab79ed`                 | `#eda100`   |
| Date      | 4    | `#fb5607`                 | `#e87ba4`   |
| ObjectId  | 5    | `#7bacf9`                 | `#008300`   |
| Object    | 6    | `#fcd15a`                 | `#4a3aa7`   |
| Array     | 7    | `#fc559b`                 | `#e34948`   |
| Null      | n/a  | `--mantine-color-dimmed`  | same        |
| Other     | n/a  | chart ink muted `#9fa1a2` | `#898781`   |

The result tree (`results/TreeView.tsx:488`) colours only null (dimmed). All other values use the default text colour, so table and tree views differ.

### Diff and highlight colors

- No diff view exists. The only grep match for "diff" in the UI sources is in `management/RenameCollectionDialog.tsx`.
- Change stream operation badges: insert `blue`, update `violet`, replace `yellow`, delete and dropDatabase `red` (`changes/changes-model.ts:134-146`). Other operations are further down the same function.
- Profiler new-row flash: `--mantine-color-yellow-light` fading to transparent over 1.5s ease-out (`profiler/profiler.css:49-60`).
- Explain highlight: orange light background and `orange-light-color` text (`explain/explain.css:293-295`).
- Explain severity bars: left border `red-6`, `yellow-6`, `blue-6` (`explain/explain.css:85-93`); red inset 3px bar at `explain/explain.css:159`.

## 10. Profiler

There is no histogram or chart in the profiler. The panel is tabs plus tables.

| Part           | Value                                                                                                                               | Where                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Layout         | Header (`ProfilerHeader.tsx`), filter row, horizontal `Tabs` (Slow queries, Top shapes), grid on the left, detail pane on the right | `profiler/ProfilerPanel.tsx:154-159`                                        |
| Slow queries   | Virtual grid, 32px rows and header, 8 base columns plus optional client and error columns                                           | `profiler/SlowQueryTable.tsx:19-71`                                         |
| Top shapes     | Mantine `Table` with `Badge` for plan, red when COLLSCAN                                                                            | `profiler/ShapesTable.tsx:59-90`                                            |
| Detail pane    | `overflow: auto`, 8px padding, left splitter (6px) with resize by drag or 24px key steps                                            | `profiler/profiler.css:102-106`, `profiler/ProfilerDetail.tsx:20,80`        |
| Detail content | Mantine `Accordion`, `SimpleGrid`, `Code`, a Monaco command viewer 220px tall                                                       | `profiler/ProfilerDetail.tsx:1,18`                                          |
| Badges         | `gray` for namespace and plan, `orange` for slow, `red` for COLLSCAN and errors, `filled` red for the error badge                   | `profiler/SlowQueryTable.tsx:297-370`, `profiler/ProfilerDetail.tsx:161`    |
| Alerts         | `light` variant: yellow for warnings, red for errors, blue for info                                                                 | `profiler/ProfilerHeader.tsx:156-161`, `profiler/ProfilerPanel.tsx:149,192` |

Share bars behind cells (mentioned in `docs/ui-guidelines.md`) are not defined in `profiler.css`.

## 11. Monitoring charts

Charts use uPlot (`monitor/UPlotChart.tsx`) with colours from `theme/palette.ts`.

| Item                    | Dark                                                              | Light                                                             | Line                       |
| ----------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------- |
| Series 1 to 8           | `#3a86ff #ffbe0b #ff006e #ab79ed #fb5607 #7bacf9 #fcd15a #fc559b` | `#2a78d6 #eb6834 #1baf7a #eda100 #e87ba4 #008300 #4a3aa7 #e34948` | `theme/palette.ts:23 / 36` |
| Card surface            | `#0f0f11`                                                         | `#fcfcfb`                                                         | 25 / 38                    |
| Ink primary             | `#f5f3ee`                                                         | `#0b0b0b`                                                         | 27 / 40                    |
| Ink secondary           | `#d0d0cd`                                                         | `#52514e`                                                         | 28 / 41                    |
| Ink muted (axis labels) | `#9fa1a2`                                                         | `#898781`                                                         | 29 / 42                    |
| Gridline                | `#222226`                                                         | `#e1e0d9`                                                         | 30 / 43                    |
| Baseline (x axis line)  | `#34343a`                                                         | `#c3c2b7`                                                         | 31 / 44                    |

Chart details:

- Line width 2, point size 8 with width 2 (`monitor/UPlotChart.tsx:211,256`).
- Area fill is the series colour at alpha `26` hex, about 15% (`monitor/UPlotChart.tsx:36`). Stacked charts fill each band to the one below.
- Axis font `11px` JetBrains Mono (line 28). Axis labels use ink muted. The x axis has no grid and a 1px baseline border (lines 230-232). The y axis has a 1px grid in the gridline colour (line 244). The y axis is 56px wide and tick spacing is 84px (x) and 40px (y) (lines 30-32). Headroom is 10% (line 34).
- Tooltip: `monitor/monitor.css:9-56`. 180px minimum width, 6px 8px padding, 1px `--mg-border`, radius `sm`, background `--mg-surface-1`, 12px text, values at 600.
- Legend chips: `monitor/monitor.css:58-92`. 2px line keys 12px wide, dashed variant, value column at least 9ch.
- Dashboard grid: 3 columns, 2 below 960px, 1 below 640px, gap `--mantine-spacing-sm` (`monitor/monitor.css:108-148`). A stale panel is at 50% opacity with a 150ms transition (line 100-106).
- The light palette sits below 3:1 contrast on its surface (comment, `theme/palette.ts:3`).

## 12. Monaco editor theme

Defined in `kit/code/editor-theme.ts`. Both themes extend a stock theme with `inherit: true` (lines 125-136). Editor font is `CODE_FONT` (`editor/MongoshMonaco.tsx:232`, `kit/code/ReadOnlyMonaco.tsx:48`), and the bundled faces are loaded and measured again before use (lines 112-124).

### Dark token colors (`mongo-gui-dark`, base `vs-dark`)

| Token        | Color     | Used for                             | Line   |
| ------------ | --------- | ------------------------------------ | ------ |
| `property`   | `#d0d0cd` | Field names, quoted keys, columns    | 38     |
| `type`       | `#ab79ed` | Collections, tables, `ObjectId`      | 39     |
| `function`   | `#a9c7fb` | Methods                              | 40     |
| `predefined` | `#fc559b` | `$gt` style operators, SQL built-ins | 41     |
| `keyword`    | `#7bacf9` | Keywords, `true`, `false`, `null`    | 42     |
| `string`     | `#fcd15a` | Strings                              | 43     |
| `number`     | `#f98d58` | Numbers                              | 44     |
| `comment`    | `#9fa1a2` | Comments, italic                     | 45, 68 |

### Dark editor colors

| Key                                      | Color                  | Line       |
| ---------------------------------------- | ---------------------- | ---------- |
| `editor.background`                      | `#0a0a0c`              | 74         |
| `editor.foreground`                      | `#f5f3ee`              | 75         |
| `editor.lineHighlightBackground`         | `#18181b`              | 76         |
| `editor.lineHighlightBorder`             | transparent            | 77         |
| `editor.selectionBackground`             | `#3d3317`              | 78         |
| `editor.inactiveSelectionBackground`     | `#2a2a2f`              | 79         |
| `editorCursor.foreground`                | `#ffd60a`              | 80         |
| `editorLineNumber.foreground`            | `#6e7276`              | 81         |
| `editorLineNumber.activeForeground`      | `#d0d0cd`              | 82         |
| `editorIndentGuide.background1`          | `#2a2a2f`              | 83         |
| Widget, suggest and hover backgrounds    | `#222226`              | 84, 86, 89 |
| Widget, suggest and hover borders        | `#34343a`              | 85, 87, 90 |
| `editorSuggestWidget.selectedBackground` | `#3d3317`              | 88         |
| Scrollbar slider, hover                  | `#34343a99`, `#3a3a40` | 91-92      |

### Light theme (`mongo-gui-light`, base `vs`)

Token colours are the VS Code light defaults: property `#001080`, type `#267F99`, function `#795E26`, predefined `#AF00DB`, keyword `#0000FF`, string `#A31515`, number `#098658`, comment `#008000` (lines 48-57). The editor colour map is empty (line 135), so the stock `vs` surfaces apply.

## 13. States

| State      | Dark theme behaviour                                                                                                                                                                                 | Where                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Hover      | List rows `--mg-hover` `#3a3a40` (tree); profiler row `--mg-surface-1`; AG Grid row `#222226`; Mantine default for buttons                                                                           | `connections/tree.css:25`, `profiler/profiler.css:41`, `results/TableView.tsx:56`       |
| Pressed    | Primary `#e0ad02`; other controls use Mantine defaults                                                                                                                                               | `theme/theme.ts:20`                                                                     |
| Selected   | Tree and AG Grid `#3d3317` amber tint; profiler `--mantine-color-blue-light`; change events `--mantine-color-default-hover`                                                                          | `connections/tree.css:29`, `profiler/profiler.css:45`, `changes/ChangesPanel.tsx:392`   |
| Focus ring | Tree 1px `--mg-accent`; profiler scroller inset 1px `blue-5`; explain 2px `blue-5`; everything else uses Mantine's focus ring (primary colour)                                                       | `connections/tree.css:34`, `profiler/profiler.css:10-12`, `explain/explain.css:150,403` |
| Disabled   | Mantine default; text `dark.3` `#6e7276`. Toolbar buttons that need one row stay disabled until exactly one row is selected                                                                          | `docs/ui-guidelines.md`                                                                 |
| Loading    | Button `loading` prop, Mantine `Loader size="sm"` (`connections/ConnectionDialog.tsx:274`), stale dashboard at 50% opacity (`monitor/monitor.css:104`)                                               |                                                                                         |
| Empty      | Dimmed text (`--mantine-color-dimmed` or `c="dimmed"`), no shared empty-state component                                                                                                              | various                                                                                 |
| Error      | Red `Alert variant="light"` (`results/ResultsPane.tsx:296`, `profiler/ProfilerPanel.tsx:149`), red toast through `notifyError` (`kit/notify-error.ts:23`), tree message tone `--mantine-color-error` |                                                                                         |
| Drag       | Dashboard panel at 50% opacity, `cursor: grab` on its header                                                                                                                                         | `monitor/monitor.css:122-128`                                                           |

## 14. Inconsistencies

1. UI font contradicts the palette doc. `docs/color-palette.md` says JetBrains Mono is used for all text. The code uses Manrope for UI text and Inter for tables (`theme/theme.ts:12,14`), with JetBrains Mono for code only.
2. Light theme contradicts the palette doc. The doc says the light scheme keeps Mantine's light greys. The code also ships a separate light chart palette (`theme/palette.ts:36-45`) and a light Monaco theme with VS Code colours (`kit/code/editor-theme.ts:48-57`), and `--mg-accent` is blue, not yellow (`theme/tokens.css:47`).
3. Variable naming does not match the doc tokens. `--mg-text` is `#d0d0cd` where the doc calls that "text-muted", and the doc's `bg` is `--mg-surface-0` (`theme/tokens.css:13,20-21`). Disabled text has no `--mg-` token.
4. The AG Grid theme hard-codes ten hex values instead of reading tokens (`results/TableView.tsx:50-59`). Its hover colour `#222226` differs from `--mg-hover` `#3a3a40`.
5. Value colours in the results table contradict `docs/ui-guidelines.md`, which says true is blue, false is grey and numbers are orange. The table uses chart slots: strings blue, Int32 amber, Double pink, Boolean light violet, Date orange (`schema/schema-model.ts:245-266`). The result tree (`results/TreeView.tsx:488`) shows no type colours at all, and the editor colours strings yellow (`kit/code/editor-theme.ts:43`).
6. The focus ring is not uniform. `docs/color-palette.md` says `#ffd60a`. The connection tree follows it (`connections/tree.css:35`), but `profiler/profiler.css:11,98` and `explain/explain.css:150,403,408` use `blue-5`.
7. `--mg-shadow` is a complete `box-shadow` value (`theme/tokens.css:22`), and `monitor/monitor.css:19` now uses it as is. It used to write `0 4px 12px var(--mg-shadow)`, which is invalid CSS and dropped the chart tooltip shadow. The doc also says dialogs have no shadow, while `kit/TreeMenu.tsx:28` sets `shadow="md"`.
8. Hard-coded Mantine dark ladder borders bypass `--mg-border` and do not follow the light scheme: `results/TreeView.tsx:295`, `editor/HistoryPanel.tsx:186`, `editor/FavouritesPanel.tsx:157`, `gridfs/GridFsFileTable.tsx:128`, `editor/EditorView.tsx:292,511`.
9. Table header colours differ. The doc says table headers are surface-2. Mantine `Table` headers are `--mg-surface-3` (`theme/theme.ts` Table styles), the AG Grid header is `#222226`, and the profiler header is `--mantine-color-body` (`profiler/profiler.css:28`).
10. Selected-row colour differs between components. Tree and AG Grid use the amber `--mg-selected`. The profiler uses `blue-light` (`profiler/profiler.css:46`), and change events use `default-hover` (`changes/ChangesPanel.tsx:392`). The result tree has no hover or selected style.
11. Violet is used as a status colour. The doc reserves it for neutral markers, but `operationColor` maps `update` to violet and `replace` to yellow, which the doc keeps for busy (`changes/changes-model.ts:139-141`). Yellow and violet are also used for Docker paused and secondary dots (`connections/tree.css:94-109`).
12. Row heights are per-component constants (28, 30, 32, 44, 52px) with no token. Examples: `results/TableView.tsx:67`, `profiler/SlowQueryTable.tsx:19`, `changes/ChangesPanel.tsx:36`, `schema/SchemaFieldTable.tsx:41`, `editor/HistoryPanel.tsx:22`.
13. Icon sizes (12, 13, 14, 16) and the text-glyph chevron in the result tree (`results/TreeView.tsx:309`) have no central rule. Tree rows elsewhere use Tabler icons in a 14px box.
14. Dialog sizes are set per dialog (`sm`, `md`, `lg`, `xl`, `640`), and no dialog reaches the 1100px width that `docs/ui-guidelines.md` allows. The guidelines also describe a loading notification that turns into a result, but no shared helper implements it (`kit/notify-error.ts` handles errors only).
15. The row tint colours in the palette doc (`#141d2e`, `#2c2410`, `#2b1810`, `#2c0d1c`, `#1d142b`) have no code definition. Components use Mantine `light` variants instead, which are computed from the solid colours.
