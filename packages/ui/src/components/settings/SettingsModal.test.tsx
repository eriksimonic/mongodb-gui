// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

  it.each([
    ['0', '1'],
    ['5000', '1440'],
  ])('clamps a typed idle lock of %s minutes to %s before saving', async (typed, saved) => {
    const { api } = renderWithApp(<SettingsModal />, {
      mock: { preset: 'unlocked' },
      initialState: { settingsOpen: true },
    });
    const field = await screen.findByLabelText('Idle lock (minutes)');
    fireEvent.change(field, { target: { value: typed } });
    fireEvent.blur(field);

    await waitFor(() => expect(screen.getByLabelText('Idle lock (minutes)')).toHaveValue(saved));
    expect((await api.rpc.settings.get()).idleLockMinutes).toBe(Number(saved));
  });

  it('restores the saved idle lock when the field is left empty', async () => {
    const { api } = renderWithApp(<SettingsModal />, {
      mock: { preset: 'unlocked' },
      initialState: { settingsOpen: true },
    });
    const update = vi.spyOn(api.rpc.settings, 'update');
    const field = await screen.findByLabelText('Idle lock (minutes)');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);

    await waitFor(() => expect(screen.getByLabelText('Idle lock (minutes)')).toHaveValue('30'));
    expect(update).not.toHaveBeenCalled();
  });
});
