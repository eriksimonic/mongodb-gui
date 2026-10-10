# Keyboard shortcuts

Open the reference in the app with Shift+? or from the "Help" menu, then "Keyboard shortcuts".

In the tables, Mod means Ctrl on Windows and Linux, and Cmd on macOS. The reference modal lists
every row of the registry in `packages/ui/src/shortcuts/shortcuts.ts`. When the app binds a new
shortcut, add its row to the registry too.

## Anywhere

| Shortcut | Action                                                    |
| -------- | --------------------------------------------------------- |
| Shift+?  | Open the keyboard shortcut reference                      |
| Mod+,    | Open Settings                                             |
| Mod+L    | Lock the app                                              |
| Mod+J    | Collapse or expand the output panel                       |
| Mod+N    | Open a new editor on the selected connection and database |

Ctrl+N and Cmd+N both work on every platform. The shortcut needs a selection in the connection
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

| Shortcut        | Action                                               |
| --------------- | ---------------------------------------------------- |
| Mod+F           | Find text in a JSON editor                           |
| Mod+Enter       | Run the selection, or the statement under the cursor |
| Mod+Shift+Enter | Run all the text in the editor                       |

In the mongosh editor, Mod+Enter and Mod+Shift+Enter use Cmd on macOS and Ctrl elsewhere. The
Explain action has no shortcut. Use the "Explain" button.

The editor component also has its own default keys, such as Ctrl+Space for suggestions. The app
does not register or list them.
