# Colour palette

This file sets the colours and the font of the app. The tokens in
`packages/ui/src/theme/tokens.css` and `packages/ui/src/theme/theme.ts` follow it.

## Base

| Colour    | Role                                                                 |
| --------- | -------------------------------------------------------------------- |
| `#000814` | App background, editor background, and the text on yellow buttons.   |
| `#001d3d` | Panels, sidebar, menus, dialogs, table headers.                      |
| `#003566` | Borders, dividers, hover and selected rows, inputs, default buttons. |
| `#ffc300` | Primary action: a filled button with `#000814` text, such as "Run".  |
| `#ffd60a` | Primary action on hover and focus, the focus ring, the active tab.   |
| `#f5f3ee` | Foreground text, off-white. Dimmed text is this colour at 65% alpha. |

Rules:

- One primary action per view gets the yellow fill. Other buttons use `#003566` with off-white
  text.
- Text on a yellow button is `#000814`. Off-white on yellow has a contrast of 1.5:1 and is not
  readable.
- Yellow never marks a status. A yellow badge would read as a button.

## Font

JetBrains Mono for all text, in the UI and in the editors. The app ships the font files in its
package and loads no font from the network, because the app must work offline. Weights 400 and
600 are enough: 400 for text and 600 for headings and button labels.

## Status colours

| Colour    | Name   | Meaning                                                                                                          |
| --------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| `#3a86ff` | Blue   | OK. Connected, a finished run, a passed check, info log lines.                                                   |
| `#ffbe0b` | Amber  | In progress. Connecting, a running query, unsaved changes, pending.                                              |
| `#fb5607` | Orange | Warning. Slow query, high lag, a warning log line, an option that needs care.                                    |
| `#ff006e` | Pink   | Error. A failed connection or query, fatal and error log lines, destructive actions such as "Drop" and "Remove". |
| `#8338ec` | Purple | Neutral marker. Tags that are not a status: read-only, replica set secondary, Docker linked, a BSON type badge.  |

Why this mapping:

- The set has no green, so blue means OK. Blue is the usual colour for a calm, normal state, and
  it is the furthest of the five from pink, so OK and error never look alike.
- Pink is the nearest colour to red, so it means error and destructive.
- Orange sits between amber and pink, so it means warning, a step short of error.
- Amber means work in progress. It is close to the primary yellow, so use it only as a dot,
  an icon or text, never as a filled button.
- Purple has no common meaning in status lights, so it marks things that are not a state.

## Contrast

Contrast ratios against the backgrounds (WCAG). Text needs 4.5:1. Icons, dots and borders need
3:1.

| Colour    | on `#000814` | on `#001d3d` | on `#003566` |
| --------- | ------------ | ------------ | ------------ |
| `#f5f3ee` | 18.1         | 15.2         | 11.1         |
| `#3a86ff` | 5.8          | 4.9          | 3.5          |
| `#ffbe0b` | 12.1         | 10.2         | 7.4          |
| `#fb5607` | 6.2          | 5.2          | 3.8          |
| `#ff006e` | 5.2          | 4.4          | 3.2          |
| `#8338ec` | 3.6          | 3.0          | 2.2          |

What follows from the table:

- On `#003566`, only off-white and amber pass for text. A selected or hovered row shows status
  with a dot or an icon, not with coloured text.
- Purple fails as text on every background, and pink is 4.4:1 on `#001d3d`. Coloured text uses
  the light shade of each status colour, listed under Tokens.
- A status never relies on colour alone. Each one also has an icon or a word, for users who
  cannot tell the colours apart.

## Tokens

Every token is one of the colours above, or a mix of two of them.

### Surfaces

| Token     | Hex       | Use                                                             |
| --------- | --------- | --------------------------------------------------------------- |
| bg-sunken | `#00050c` | Editor and results grid                                         |
| bg        | `#000814` | App background                                                  |
| surface-1 | `#001228` | Sidebar and dock                                                |
| surface-2 | `#001d3d` | Panels, menus, dialogs, table headers                           |
| surface-3 | `#002952` | Inputs and default buttons                                      |
| border    | `#003566` | Dividers and outlines                                           |
| hover     | `#1a497c` | A hovered row or button                                         |
| selected  | `#0e498c` | A selected tree row or grid cell, `#003566` mixed 25% with blue |

### Text

| Token         | Hex       | Contrast on `#001d3d` | Use                             |
| ------------- | --------- | --------------------- | ------------------------------- |
| text          | `#f5f3ee` | 15.2                  | Body text                       |
| text-muted    | `#d0d0cd` | 10.9                  | Labels, secondary values        |
| text-dim      | `#9fa1a2` | 6.5                   | Hints, timestamps, empty states |
| text-disabled | `#6e7276` | 3.5                   | Disabled items only             |

### Primary

`#ffc300` at rest, `#ffd60a` on hover, `#e0ad02` when pressed. The text is `#000814` in all three.
`#ffd60a` is also the focus ring and the line under the active tab.

### Status shades

The solid shade is for dots, icons and badge fills. The light shade is for text on a panel. The
tint is a row background.

| Status  | Solid     | Light     | Tint      |
| ------- | --------- | --------- | --------- |
| OK      | `#3a86ff` | `#7bacf9` | `#071730` |
| Busy    | `#ffbe0b` | `#fcd15a` | `#1f1e13` |
| Warning | `#fb5607` | `#f98d58` | `#1e1112` |
| Error   | `#ff006e` | `#fc559b` | `#1f071f` |
| Marker  | `#8338ec` | `#ab79ed` | `#100e2e` |

A warning or error log row has the tint as its background and a 3px left bar in the solid shade.

### Editor and JSON

| Element                         | Colour    |
| ------------------------------- | --------- |
| Keywords such as `SELECT`, `db` | `#7bacf9` |
| Strings                         | `#fcd15a` |
| Numbers                         | `#f98d58` |
| Operators such as `$match`      | `#fc559b` |
| Field names                     | `#d0d0cd` |
| `ObjectId`, `ISODate`           | `#ab79ed` |
| Comments, in italics            | `#9fa1a2` |
| Booleans and `null`             | `#7bacf9` |

### Charts

Series take the status colours in this order: `#3a86ff`, `#ffbe0b`, `#ff006e`, `#8338ec`,
`#fb5607`. Each line has a 15% fill of its colour below it.

### Shape

- A layer is one surface step lighter than the layer below it. A dialog is surface-2 over a
  backdrop of bg at 70%, with no shadow.
- Borders are 1px `#003566`. No drop shadows.
- Radius is 4px on buttons and inputs, 6px on panels and dialogs.
