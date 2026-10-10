import { describe, expect, it, vi } from 'vitest';
import { SHORTCUTS, formatShortcut, parseKeys, shellHotkeys } from './shortcuts';

describe('shortcut registry', () => {
  it('gives every shortcut a unique id', () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lists the shortcuts the app has today', () => {
    const actions = SHORTCUTS.map((shortcut) => shortcut.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'Open settings',
        'Lock the app',
        'Close the open dialog',
        'Submit the dialog form',
        'Find text in a JSON editor',
      ]),
    );
  });

  it('registers the window hotkeys from the same list', () => {
    const openSettings = vi.fn();
    const lock = vi.fn();
    const openHelp = vi.fn();
    const hotkeys = shellHotkeys({ openSettings, lock, openHelp });

    expect(hotkeys.map(([keys]) => keys)).toEqual(['mod+,', 'mod+l', 'shift+?']);
    for (const [, action] of hotkeys) {
      action();
    }
    expect(openSettings).toHaveBeenCalledOnce();
    expect(lock).toHaveBeenCalledOnce();
    expect(openHelp).toHaveBeenCalledOnce();
  });
});

describe('parseKeys', () => {
  it('splits alternatives and modifiers', () => {
    expect(parseKeys('Shift+F10, ContextMenu')).toEqual([['Shift', 'F10'], ['ContextMenu']]);
  });
});

describe('formatShortcut', () => {
  it('shows mod as Ctrl on Linux and Windows', () => {
    expect(formatShortcut('mod+l', 'Linux x86_64')).toBe('Ctrl+L');
    expect(formatShortcut('mod+,', 'Win32')).toBe('Ctrl+,');
  });

  it('shows mod as Cmd on macOS', () => {
    expect(formatShortcut('mod+l', 'MacIntel')).toBe('Cmd+L');
  });

  it('joins alternatives with or', () => {
    expect(formatShortcut('Up, Down', 'Linux')).toBe('Up or Down');
  });

  it('writes shift and the other modifiers by name', () => {
    expect(formatShortcut('shift+?', 'Linux')).toBe('Shift+?');
    expect(formatShortcut('alt+x', 'MacIntel')).toBe('Option+X');
  });
});
