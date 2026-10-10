// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../../test-support/render';
import { SettingsModal } from './SettingsModal';
import { LICENCE_URL, PROJECT_URL } from './links';

function renderSettings() {
  return renderWithApp(<SettingsModal />, {
    mock: { preset: 'unlocked' },
    initialState: { settingsOpen: true },
  });
}

describe('SettingsModal sections', () => {
  it('shows every section heading', async () => {
    renderSettings();
    for (const title of ['Appearance', 'Security', 'Connections', 'Updates', 'Data', 'About']) {
      expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    }
  });

  it('saves the theme and shows the choice', async () => {
    const { api } = renderSettings();
    fireEvent.click(await screen.findByRole('radio', { name: 'Light' }));

    await waitFor(async () => expect((await api.rpc.settings.get()).theme).toBe('light'));
    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked();
  });

  it('switches the page to the light scheme when the theme is light', async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole('radio', { name: 'Light' }));

    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('light'),
    );
  });

  it('saves the editor font size, clamped on blur', async () => {
    const { api } = renderSettings();
    const field = await screen.findByLabelText('Editor font size');
    fireEvent.change(field, { target: { value: '99' } });
    fireEvent.blur(field);

    await waitFor(async () => expect((await api.rpc.settings.get()).editorFontSize).toBe(32));
    expect(screen.getByLabelText('Editor font size')).toHaveValue('32');
  });

  it('saves the tree density', async () => {
    const { api } = renderSettings();
    fireEvent.click(await screen.findByRole('radio', { name: 'Comfortable' }));

    await waitFor(async () =>
      expect((await api.rpc.settings.get()).treeDensity).toBe('comfortable'),
    );
  });

  it('resets the saved layout', async () => {
    const { api } = renderSettings();
    await api.rpc.layout.set({ key: 'dockview:main', value: { grid: {}, panels: {} } });

    fireEvent.click(await screen.findByRole('button', { name: 'Reset layout' }));

    await waitFor(async () =>
      expect(await api.rpc.layout.get({ key: 'dockview:main' })).toEqual({ value: null }),
    );
  });

  it('opens the change password dialog from the security section', async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Change master password' }));

    const dialog = await screen.findByRole('dialog', { name: 'Change master password' });
    expect(within(dialog).getByLabelText('Current master password')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('New master password')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Confirm new master password')).toBeInTheDocument();
  });

  it('locks the vault from the security section', async () => {
    const { api } = renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Lock now' }));

    await waitFor(async () => expect((await api.rpc.vault.status()).state).toBe('locked'));
  });

  it('saves the Docker auto connect switch', async () => {
    const { api } = renderSettings();
    fireEvent.click(await screen.findByRole('switch', { name: /Connect Docker instances/ }));

    await waitFor(async () => expect((await api.rpc.settings.get()).dockerAutoConnect).toBe(true));
  });

  it('shows the current version and runs a check', async () => {
    const { api } = renderSettings();
    const check = vi.spyOn(api.rpc.updates, 'check');
    expect(await screen.findByText(/Last checked: Never/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(check).toHaveBeenCalledOnce());
  });

  it('clears the history after a confirmation', async () => {
    const { api } = renderSettings();
    const clear = vi.spyOn(api.rpc.history, 'clear');
    fireEvent.click(await screen.findByRole('button', { name: 'Clear history' }));

    // The confirm dialog holds a second button with the same name, so it is found inside the dialog.
    const confirmDialog = await screen.findByRole('dialog', { name: 'Clear query history' });
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Clear history' }));
    await waitFor(() => expect(clear).toHaveBeenCalledOnce());
  });

  it('enables the export and import buttons', async () => {
    renderSettings();
    expect(await screen.findByRole('button', { name: 'Export connections' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Import connections' })).toBeEnabled();
  });

  it('opens the export dialog from the data section', async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Export connections' }));

    expect(await screen.findByRole('dialog', { name: 'Export connections' })).toBeInTheDocument();
  });

  it('opens the import dialog after the open dialog returns a file', async () => {
    const { api } = renderSettings();
    const open = vi.spyOn(api.rpc.app, 'showOpenDialog');
    fireEvent.click(await screen.findByRole('button', { name: 'Import connections' }));

    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(await screen.findByRole('dialog', { name: 'Import connections' })).toBeInTheDocument();
  });

  it('shows the runtime versions and opens the project links through openExternal', async () => {
    const { api } = renderSettings();
    const open = vi.spyOn(api.rpc.app, 'openExternal');
    expect(await screen.findByText(/Electron /)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Repository' }));
    fireEvent.click(screen.getByRole('button', { name: 'Licence (MIT)' }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(open).toHaveBeenNthCalledWith(1, { url: PROJECT_URL });
    expect(open).toHaveBeenNthCalledWith(2, { url: LICENCE_URL });
  });

  it('closes on Escape', async () => {
    renderSettings();
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
  });
});
