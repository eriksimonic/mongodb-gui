# Keyboard shortcuts

Open the reference in the app with Shift+? or from the "Help" menu, then "Keyboard shortcuts".

In the tables, Mod means Ctrl on Windows and Linux, and Cmd on macOS. The shortcuts that the
reference lists come from one registry in `packages/ui/src/shortcuts/shortcuts.ts`. Shortcuts
that the editor and the shell register in code appear in their own table. The reference does not
list them.

## Anywhere

| Shortcut        | Action                                                    | Source                     |
| --------------- | --------------------------------------------------------- | -------------------------- |
| Shift+?         | Open the keyboard shortcut reference                      | Registry                   |
| Mod+,           | Open Settings                                             | Registry                   |
| Mod+L           | Lock the app                                              | Registry                   |
| Ctrl+N or Cmd+N | Open a new editor on the selected connection and database | Code, not in the reference |

Ctrl+N works with either Ctrl or Cmd on every platform. It needs a selection in the connection
tree, and it does nothing when no connection is selected. Holding Shift or Alt with the key cancels
it.

## Connection tree

| Shortcut                 | Action                                                    |
| ------------------------ | --------------------------------------------------------- |
| Up, Down                 | Move between rows                                         |
| Home, End                | Jump to the first or last row                             |
| Right, Left              | Expand or collapse a node, or move to its child or parent |
| Enter                    | Connect, or open the selected row                         |
| Shift+F10 or ContextMenu | Open the context menu for the row                         |

## Tables

| Shortcut  | Action                                   |
| --------- | ---------------------------------------- |
| Up, Down  | Move between rows in a profiler table    |
| Home, End | Jump to the first or last row in a table |

## Dialogs

| Shortcut | Action                                   |
| -------- | ---------------------------------------- |
| Escape   | Close the open dialog                    |
| Enter    | Submit the form in a dialog that has one |

## Editors

| Shortcut        | Action                                               | Source                     |
| --------------- | ---------------------------------------------------- | -------------------------- |
| Mod+F           | Find text in a JSON editor                           | Registry                   |
| Mod+Enter       | Run the selection, or the statement under the cursor | Code, not in the reference |
| Mod+Shift+Enter | Run all the text in the editor                       | Code, not in the reference |

In the mongosh editor, Mod+Enter and Mod+Shift+Enter use Cmd on macOS and Ctrl elsewhere. The
Explain action has no shortcut. Use the "Explain" button.

The editor component also has its own default keys, such as Ctrl+Space for suggestions. The app
does not register or list them.
