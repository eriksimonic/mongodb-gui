// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { ShortcutsModal } from './ShortcutsModal';
import { SHORTCUTS } from './shortcuts';

describe('ShortcutsModal', () => {
  it('lists every shortcut in a two column table', async () => {
    renderWithApp(<ShortcutsModal />, {
      mock: { preset: 'unlocked' },
      initialState: { shortcutsOpen: true },
    });

    const table = await screen.findByRole('table', { name: 'Keyboard shortcuts' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Shortcut', 'Action']);
    for (const shortcut of SHORTCUTS) {
      expect(within(table).getByText(shortcut.action)).toBeInTheDocument();
    }
  });

  it('shows the settings key for the current platform', async () => {
    renderWithApp(<ShortcutsModal />, {
      mock: { preset: 'unlocked' },
      initialState: { shortcutsOpen: true },
    });
    const table = await screen.findByRole('table', { name: 'Keyboard shortcuts' });
    const row = within(table).getByText('Open settings').closest('tr');
    expect(row?.textContent).toMatch(/^(Ctrl|Cmd)\+,/);
  });

  it('renders nothing when closed', () => {
    renderWithApp(<ShortcutsModal />, {
      mock: { preset: 'unlocked' },
      initialState: { shortcutsOpen: false },
    });
    expect(screen.queryByRole('table', { name: 'Keyboard shortcuts' })).toBeNull();
  });
});
