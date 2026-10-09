// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithApp } from '../../test-support/render';
import { SettingsModal } from './SettingsModal';

describe('SettingsModal', () => {
  it('shows the update check switch on and saves the change', async () => {
    const { api } = renderWithApp(<SettingsModal />, {
      mock: { preset: 'unlocked' },
      initialState: { settingsOpen: true },
    });

    const toggle = await screen.findByRole('switch', { name: /Check for updates/ });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /Check for updates/ })).not.toBeChecked(),
    );
    expect((await api.rpc.settings.get()).checkForUpdates).toBe(false);
  });

  it('turns the update check back on', async () => {
    const { api } = renderWithApp(<SettingsModal />, {
      mock: { preset: 'unlocked' },
      initialState: { settingsOpen: true },
    });
    fireEvent.click(await screen.findByRole('switch', { name: /Check for updates/ }));
    await waitFor(async () => expect((await api.rpc.settings.get()).checkForUpdates).toBe(false));

    fireEvent.click(screen.getByRole('switch', { name: /Check for updates/ }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /Check for updates/ })).toBeChecked(),
    );
    expect((await api.rpc.settings.get()).checkForUpdates).toBe(true);
  });

  it('shows the idle lock minutes from the saved settings', async () => {
    renderWithApp(<SettingsModal />, {
      mock: { preset: 'unlocked' },
      initialState: { settingsOpen: true },
    });
    expect(await screen.findByLabelText('Idle lock (minutes)')).toHaveValue('30');
  });

  it('renders nothing when closed', () => {
    renderWithApp(<SettingsModal />, {
      mock: { preset: 'unlocked' },
      initialState: { settingsOpen: false },
    });
    expect(screen.queryByText('Settings')).toBeNull();
  });
});
