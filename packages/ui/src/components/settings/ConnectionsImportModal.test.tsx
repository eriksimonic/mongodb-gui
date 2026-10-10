// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { localConnectionId } from '../../api/mock-fixtures';
import type { UiApi } from '../../api/ui-api';
import { renderWithApp } from '../../test-support/render';
import { ConnectionsImportModal } from './ConnectionsImportModal';

const PASSPHRASE = 'export passphrase';

/** Exports the local connection to the path the mock save dialog returns. */
async function exportLocal(api: UiApi, passphrase = PASSPHRASE): Promise<void> {
  const saved = await api.rpc.app.showSaveDialog({ title: 'Save', filters: [] });
  if (saved.path === undefined) {
    throw new Error('the mock save dialog returned no path');
  }
  await api.rpc.connections.exportToFile({
    profileIds: [localConnectionId],
    passphrase,
    path: saved.path,
  });
}

/** Opens the import modal on the file the mock open dialog returns, as the Settings button does. */
async function openImport(api: UiApi): Promise<void> {
  const picked = await api.rpc.app.showOpenDialog({ title: 'Choose a file', filters: [] });
  renderWithApp(<ConnectionsImportModal path={picked.path} onClose={() => undefined} />, { api });
}

async function readFile(passphrase: string) {
  fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: passphrase } });
  fireEvent.click(screen.getByRole('button', { name: 'Read file' }));
}

describe('ConnectionsImportModal', () => {
  it('stays closed while no file is picked', () => {
    renderWithApp(<ConnectionsImportModal path={undefined} onClose={() => undefined} />, {
      mock: { preset: 'unlocked' },
    });
    expect(screen.queryByRole('dialog', { name: 'Import connections' })).toBeNull();
  });

  it('refuses a short passphrase before reading the file', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const preview = vi.spyOn(api.rpc.connections, 'previewImport');
    await openImport(api);

    await readFile('short');

    expect(await screen.findByText('The passphrase must be at least 10 characters.')).toBeVisible();
    expect(preview).not.toHaveBeenCalled();
  });

  it('previews the connections with the name-in-use flag and the auth kind, without secrets', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await openImport(api);

    await readFile(PASSPHRASE);

    const table = await screen.findByRole('table', { name: 'Connections in the file' });
    expect(within(table).getByText('Staging')).toBeInTheDocument();
    expect(within(table).getByText('Exists')).toBeInTheDocument();
    expect(within(table).getByText('Reporting')).toBeInTheDocument();
    expect(within(table).getByText('Username and password')).toBeInTheDocument();
    expect(screen.queryByText(/staging-secret/)).toBeNull();
  });

  it('shows a red alert when the passphrase does not open the file', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await exportLocal(api);
    await openImport(api);

    await readFile('a wrong passphrase');

    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong passphrase or damaged file.');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('imports with skip, reports the counts and reloads the tree', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await openImport(api);
    await readFile(PASSPHRASE);
    await screen.findByRole('table', { name: 'Connections in the file' });
    fireEvent.click(screen.getByRole('radio', { name: 'Skip connections whose name exists' }));
    const before = (await api.rpc.connections.list()).length;
    const list = vi.spyOn(api.rpc.connections, 'list');

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Imported 1, renamed 0, replaced 0, skipped 1.',
    );
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect((await api.rpc.connections.list()).length).toBe(before + 1);
  });

  it('imports as copies when rename is chosen, which is the default', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await openImport(api);
    await readFile(PASSPHRASE);
    await screen.findByRole('table', { name: 'Connections in the file' });
    expect(screen.getByRole('radio', { name: /Import as copies/ })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Imported 2, renamed 1, replaced 0, skipped 0.',
    );
    const names = (await api.rpc.connections.list()).map((connection) => connection.name);
    expect(names).toContain('Staging (2)');
  });

  it('replaces the existing connection in replace mode', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await openImport(api);
    await readFile(PASSPHRASE);
    await screen.findByRole('table', { name: 'Connections in the file' });
    fireEvent.click(screen.getByRole('radio', { name: 'Replace the existing connection' }));

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Imported 1, renamed 0, replaced 1, skipped 0.',
    );
    const staging = (await api.rpc.connections.list()).find(
      (connection) => connection.name === 'Staging',
    );
    expect(staging?.uriRedacted).toContain('staging.example.com');
  });
});
