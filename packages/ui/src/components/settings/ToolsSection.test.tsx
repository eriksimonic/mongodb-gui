// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithApp } from '../../test-support/render';
import type { MockToolsMode } from '../../api/mock-tools';
import { SettingsModal } from './SettingsModal';

function renderSettings(tools: MockToolsMode = 'ok') {
  return renderWithApp(<SettingsModal />, {
    mock: { preset: 'unlocked', tools },
    initialState: { settingsOpen: true },
  });
}

describe('ToolsSection', () => {
  it('lists the bundled and downloaded installs', async () => {
    renderSettings();
    const bundled = await screen.findByTestId('tools-row-bundled');
    expect(within(bundled).getByText('100.19.1')).toBeInTheDocument();
    expect(within(bundled).getByText('Bundled')).toBeInTheDocument();
    const downloaded = screen.getByTestId('tools-row-downloaded:100.12.1');
    expect(within(downloaded).getByText('Downloaded')).toBeInTheDocument();
    expect(within(bundled).queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('shows the health message of a broken install', async () => {
    renderSettings('broken');
    const bundled = await screen.findByTestId('tools-row-bundled');
    expect(within(bundled).getByText(/libgssapi_krb5/)).toBeInTheDocument();
  });

  it('shows an empty state when no tools are installed', async () => {
    renderSettings('missing');
    expect(await screen.findByText('No tools are installed.')).toBeInTheDocument();
  });

  it('saves the default version', async () => {
    const { api } = renderSettings();
    const row = await screen.findByTestId('tools-row-downloaded:100.12.1');
    fireEvent.click(within(row).getByRole('radio'));

    await waitFor(async () =>
      expect((await api.rpc.settings.get()).mongoToolsVersion).toBe('100.12.1'),
    );
  });

  it('removes a downloaded install', async () => {
    const { api } = renderSettings();
    const row = await screen.findByTestId('tools-row-downloaded:100.12.1');
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(screen.queryByTestId('tools-row-downloaded:100.12.1')).toBeNull());
    expect((await api.rpc.tools.list()).installs).toHaveLength(1);
  });

  it('opens the licence', async () => {
    renderSettings();
    const row = await screen.findByTestId('tools-row-bundled');
    fireEvent.click(within(row).getByRole('button', { name: 'Licence' }));

    expect(await screen.findByText(/Apache License, Version 2.0/)).toBeInTheDocument();
  });

  it('downloads another version and lists it', async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Download another version…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Download MongoDB Database Tools' });
    fireEvent.click(within(dialog).getByRole('textbox', { name: 'Version' }));
    fireEvent.click(await screen.findByRole('option', { name: '100.15.0' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download' }));

    expect(
      await screen.findByTestId('tools-row-downloaded:100.15.0', {}, { timeout: 4000 }),
    ).toBeInTheDocument();
  });

  it('shows the bundled tools line in the about section', async () => {
    renderSettings();
    expect(
      await screen.findByText('Includes MongoDB Database Tools 100.19.1, Apache License 2.0'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tools licence' })).toBeInTheDocument();
  });

  it('omits the bundled tools line when nothing is bundled', async () => {
    renderSettings('missing');
    await screen.findByText('No tools are installed.');
    expect(screen.queryByRole('button', { name: 'Tools licence' })).toBeNull();
  });
});
