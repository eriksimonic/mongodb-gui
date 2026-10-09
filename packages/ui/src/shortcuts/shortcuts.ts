/**
 * Every keyboard shortcut the app has. The reference modal lists these rows, and the shell
 * registers the global ones. The editor phase adds its rows here.
 *
 * Keys use Mantine's hotkey syntax: `mod` is Ctrl on Windows and Linux and Cmd on macOS, and
 * alternatives are separated by ", ". Each row names one action, so a key that does two things
 * gets two rows.
 */
export type ShortcutScope = 'global' | 'tree' | 'table' | 'dialog' | 'editor';

export interface Shortcut {
  readonly id: string;
  readonly keys: string;
  readonly action: string;
  readonly scope: ShortcutScope;
}

export const SHORTCUTS: readonly Shortcut[] = [
  // Mantine matches the shift state exactly, so the question mark needs shift spelled out.
  { id: 'help', keys: 'shift+?', action: 'Open this shortcut reference', scope: 'global' },
  { id: 'settings', keys: 'mod+,', action: 'Open settings', scope: 'global' },
  { id: 'lock', keys: 'mod+l', action: 'Lock the app', scope: 'global' },
  {
    id: 'tree-move',
    keys: 'Up, Down',
    action: 'Move between rows in the connection tree',
    scope: 'tree',
  },
  {
    id: 'tree-edges',
    keys: 'Home, End',
    action: 'Jump to the first or last row in the tree',
    scope: 'tree',
  },
  {
    id: 'tree-expand',
    keys: 'Right, Left',
    action: 'Expand or collapse a node, or move to its child or parent',
    scope: 'tree',
  },
  { id: 'tree-open', keys: 'Enter', action: 'Connect or open the selected row', scope: 'tree' },
  {
    id: 'tree-menu',
    keys: 'Shift+F10, ContextMenu',
    action: 'Open the context menu for the row',
    scope: 'tree',
  },
  {
    id: 'table-move',
    keys: 'Up, Down',
    action: 'Move between rows in a profiler table',
    scope: 'table',
  },
  {
    id: 'table-edges',
    keys: 'Home, End',
    action: 'Jump to the first or last row in a table',
    scope: 'table',
  },
  { id: 'dialog-close', keys: 'Escape', action: 'Close the open dialog', scope: 'dialog' },
  { id: 'dialog-submit', keys: 'Enter', action: 'Submit the dialog form', scope: 'dialog' },
  { id: 'editor-find', keys: 'mod+f', action: 'Find text in a JSON editor', scope: 'editor' },
];

export const SCOPE_LABELS: Readonly<Record<ShortcutScope, string>> = {
  global: 'Anywhere',
  tree: 'Connection tree',
  table: 'Tables',
  dialog: 'Dialogs',
  editor: 'Editors',
};

/** Splits a keys string into its alternatives, each a list of key names. */
export function parseKeys(keys: string): string[][] {
  return keys.split(', ').map((alternative) => alternative.split('+'));
}

/**
 * Writes a keys string for display. `mod` becomes Cmd on macOS and Ctrl elsewhere. Single letters
 * are upper case, and alternatives are joined with "or".
 */
export function formatShortcut(keys: string, platform: string): string {
  const isMac = platform === 'MacIntel' || platform === 'darwin' || platform.startsWith('Mac');
  return parseKeys(keys)
    .map((parts) => parts.map((part) => formatPart(part, isMac)).join('+'))
    .join(' or ');
}

function formatPart(part: string, isMac: boolean): string {
  switch (part) {
    case 'mod':
      return isMac ? 'Cmd' : 'Ctrl';
    case 'shift':
      return 'Shift';
    case 'alt':
      return isMac ? 'Option' : 'Alt';
    default:
      return part.length === 1 ? part.toUpperCase() : part;
  }
}

/** Keys the shell listens for at the window level. Each maps to the action it runs. */
export interface ShellHotkeyHandlers {
  readonly openSettings: () => void;
  readonly lock: () => void;
  readonly openHelp: () => void;
}

/**
 * The window-level hotkeys, in the form Mantine's useHotkeys takes. The keys come from SHORTCUTS,
 * so the reference and the bindings cannot drift apart.
 */
export function shellHotkeys(handlers: ShellHotkeyHandlers): [string, () => void][] {
  return [
    [keysFor('settings'), handlers.openSettings],
    [keysFor('lock'), handlers.lock],
    [keysFor('help'), handlers.openHelp],
  ];
}

function keysFor(id: string): string {
  const shortcut = SHORTCUTS.find((candidate) => candidate.id === id);
  if (shortcut === undefined) {
    throw new Error(`Unknown shortcut: ${id}`);
  }
  return shortcut.keys;
}
