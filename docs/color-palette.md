# Colour palette

This file sets the colours and the font of the app. The tokens in
`packages/ui/src/theme/tokens.css` and `packages/ui/src/theme/theme.ts` follow it. Only the dark
scheme uses the surfaces below. The light scheme keeps Mantine's light greys and takes the yellow
primary and the status colours.

## Base

The surfaces are neutral graphite, so the yellow stands out and no surface competes with it.

| Colour    | Role                                                                |
| --------- | ------------------------------------------------------------------- |
| `#0f0f11` | App background, and the text on yellow buttons.                     |
| `#222226` | Panels, menus, dialogs, table headers.                              |
| `#34343a` | Borders and dividers.                                               |
| `#ffc300` | Primary action: a filled button with `#0f0f11` text, such as "Run". |
| `#ffd60a` | Primary action on hover, the focus ring, the active tab.            |
| `#f5f3ee` | Foreground text, off-white.                                         |

Rules:

- One primary action per view gets the yellow fill. Other buttons use the input grey with
  off-white text.
- Text on a yellow button is `#0f0f11` (11.9:1). Off-white on yellow is 1.5:1 and is not
  readable.
- Yellow never marks a status. A yellow badge would read as a button.

## Font

JetBrains Mono for all text, in the UI and in the editors. The app ships the font files in its
package (`@fontsource/jetbrains-mono`) and loads no font from the network, because the app must
work offline. It loads weight 400, its italic for editor comments, and 600 for headings and
button labels.

## Status colours

| Colour    | Name   | Meaning                                                                                                          |
| --------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| `#3a86ff` | Blue   | OK. Connected, a finished run, a passed check, info log lines.                                                   |
| `#ffbe0b` | Amber  | In progress. Connecting, a running query, unsaved changes, pending.                                              |
| `#fb5607` | Orange | Warning. Slow query, high lag, a warning log line, an option that needs care.                                    |
| `#ff006e` | Pink   | Error. A failed connection or query, fatal and error log lines, destructive actions such as "Drop" and "Remove". |
| `#8338ec` | Purple | Neutral marker. Tags that are not a status: read-only, replica set secondary, a categorical badge.               |

Why this mapping:

- The set has no green, so blue means OK. Blue is the usual colour for a calm, normal state, and
  it is the furthest of the five from pink, so OK and error never look alike.
- Pink is the nearest colour to red, so it means error and destructive.
- Orange sits between amber and pink, so it means warning, a step short of error.
- Amber means work in progress. It is close to the primary yellow, so use it only as a dot,
  an icon or text, never as a filled button.
- Purple has no common meaning in status lights, so it marks things that are not a state.

In code, Mantine's `blue`, `yellow`, `orange`, `red` and `violet` are these colours. The app uses
no `green` or `teal`.

## Contrast

Contrast ratios against the surfaces (WCAG). Text needs 4.5:1. Icons, dots and borders need 3:1.

| Colour    | on `#0f0f11` | on `#222226` | on `#34343a` |
| --------- | ------------ | ------------ | ------------ |
| `#f5f3ee` | 17.3         | 14.3         | 11.2         |
| `#3a86ff` | 5.5          | 4.6          | 3.6          |
| `#ffbe0b` | 11.5         | 9.5          | 7.4          |
| `#fb5607` | 5.9          | 4.9          | 3.8          |
| `#ff006e` | 5.0          | 4.1          | 3.2          |
| `#8338ec` | 3.4          | 2.8          | 2.2          |

What follows from the table:

- Purple fails as text on every surface, and pink is 4.1:1 on `#222226`. Coloured text uses the
  light shade of each status colour, listed under Tokens.
- A status never relies on colour alone. Each one also has an icon or a word, for users who
  cannot tell the colours apart.

## Tokens

### Surfaces

| Token     | Hex       | Use                                                                                |
| --------- | --------- | ---------------------------------------------------------------------------------- |
| bg-sunken | `#0a0a0c` | Editor and results grid                                                            |
| bg        | `#0f0f11` | App background                                                                     |
| surface-1 | `#18181b` | Sidebar, dock tab bars, editor current line                                        |
| surface-2 | `#222226` | Panels, menus, dialogs, table headers                                              |
| surface-3 | `#2a2a2f` | Inputs and default buttons                                                         |
| border    | `#34343a` | Dividers and outlines                                                              |
| hover     | `#3a3a40` | A hovered row or button                                                            |
| selected  | `#3d3317` | A selected tree row, grid row or editor text, a dark amber that ties to the yellow |

### Text

| Token         | Hex       | Contrast on `#222226` | Use                             |
| ------------- | --------- | --------------------- | ------------------------------- |
| text          | `#f5f3ee` | 14.3                  | Body text                       |
| text-muted    | `#d0d0cd` | 10.3                  | Labels, secondary values        |
| text-dim      | `#9fa1a2` | 6.1                   | Hints, timestamps, empty states |
| text-disabled | `#6e7276` | 3.3                   | Disabled items only             |

### Primary

`#ffc300` at rest, `#ffd60a` on hover, `#e0ad02` when pressed. The text is `#0f0f11` in all three.
`#ffd60a` is also the focus ring, the editor cursor and the line under the active tab.

### Status shades

The solid shade is for dots, icons and badge fills. The light shade is for text on a panel. The
tint is a row background, the solid colour at 12% over `#0f0f11`.

| Status  | Solid     | Light     | Tint      |
| ------- | --------- | --------- | --------- |
| OK      | `#3a86ff` | `#7bacf9` | `#141d2e` |
| Busy    | `#ffbe0b` | `#fcd15a` | `#2c2410` |
| Warning | `#fb5607` | `#f98d58` | `#2b1810` |
| Error   | `#ff006e` | `#fc559b` | `#2c0d1c` |
| Marker  | `#8338ec` | `#ab79ed` | `#1d142b` |

A warning or error log row has the tint as its background and a 3px left bar in the solid shade.

### Editor and JSON

| Element                         | Colour    |
| ------------------------------- | --------- |
| Keywords such as `SELECT`, `db` | `#7bacf9` |
| Methods such as `find`          | `#a9c7fb` |
| Strings                         | `#fcd15a` |
| Numbers                         | `#f98d58` |
| Operators such as `$match`      | `#fc559b` |
| Field names                     | `#d0d0cd` |
| Collections, `ObjectId`         | `#ab79ed` |
| Comments, in italics            | `#9fa1a2` |
| Booleans and `null`             | `#7bacf9` |

### Charts

Series take these colours in order: `#3a86ff`, `#ffbe0b`, `#ff006e`, `#ab79ed`, `#fb5607`,
`#7bacf9`, `#fcd15a`, `#fc559b`. The first five are the status colours, with the light violet,
because the results grid prints BSON type colours from the same list as text. Each line has a 15%
fill of its colour below it.

### Shape

- A layer is one surface step lighter than the layer below it. A dialog is surface-2 over a
  backdrop of bg at 70%, with no shadow.
- Borders are 1px `#34343a`.
- Radius is 4px on buttons and inputs, 6px on panels and dialogs.
