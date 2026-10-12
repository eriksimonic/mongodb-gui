// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockUiApi, type MockUiApiOptions } from '../../api/mock-rpc-client';
import { localConnectionId } from '../../api/mock-fixtures';
import type { UiApi } from '../../api/ui-api';
import { renderWithApp } from '../../test-support/render';
import { BackupDialogBody } from './BackupDialog';

async function renderDialog(
  props: { database?: string; collection?: string } = { database: 'shop' },
  mock: MockUiApiOptions = { preset: 'unlocked' },
): Promise<UiApi> {
  const api = createMockUiApi(mock);
  await api.rpc.connections.connect({ id: localConnectionId });
  renderWithApp(
    <BackupDialogBody connectionId={localConnectionId} onClose={() => undefined} {...props} />,
    { api },
  );
  if (props.database !== 'admin') {
    await waitFor(() => expect(screen.getByTestId('estimate')).toBeInTheDocument());
  }
  return api;
}

async function chooseFolder() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
  await waitFor(() => expect(screen.getByLabelText('Folder')).not.toHaveValue(''));
}

describe('BackupDialog', () => {
  it('starts from the defaults for a database target', async () => {
    await renderDialog();
    expect(screen.getByLabelText('Compress with gzip')).toBeChecked();
    expect(screen.getByLabelText('Views as collections')).not.toBeChecked();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toMatch(/-shop-\d{8}-\d{6}$/);
    expect(screen.getByRole('radio', { name: 'Single archive file' })).toBeChecked();
    expect(screen.getByLabelText('Parallel collections')).toHaveValue('4');
    expect(screen.getByRole('button', { name: 'Start backup' })).toBeDisabled();
    expect(screen.getByTestId('estimate')).toHaveTextContent(
      /About .* documents in \d+ collections/,
    );
  });

  it('lists and selects a version downloaded from the tools picker', async () => {
    await renderDialog();
    fireEvent.click(screen.getByRole('textbox', { name: 'Tools version' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Download another version…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Download MongoDB Database Tools' });
    fireEvent.click(await within(dialog).findByRole('textbox', { name: 'Version' }));
    fireEvent.click(await screen.findByRole('option', { name: '100.15.0' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(
      () =>
        expect(screen.getByRole('textbox', { name: 'Tools version' })).toHaveValue(
          '100.15.0 (Downloaded)',
        ),
      { timeout: 4000 },
    );
  });

  it('disables the oplog and users and roles when the scope does not allow them', async () => {
    await renderDialog({ database: 'admin' });
    expect(screen.getByLabelText('Point-in-time (oplog)')).toBeDisabled();
    expect(screen.getByLabelText('Users and roles')).toBeDisabled();
  });

  it('allows users and roles for a database other than admin', async () => {
    await renderDialog();
    expect(screen.getByLabelText('Users and roles')).toBeEnabled();
  });

  it('fills the folder from the folder dialog and shows the output preview', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    const spy = vi.spyOn(api.rpc.app, 'showOpenDialog');
    renderWithApp(
      <BackupDialogBody
        connectionId={localConnectionId}
        database="shop"
        onClose={() => undefined}
      />,
      { api },
    );
    await chooseFolder();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(screen.getByTestId('output-preview')).toHaveTextContent(/^Writes .*\.archive\.gz and /);
    expect(screen.getByRole('button', { name: 'Start backup' })).toBeEnabled();
  });

  it('sends the draft as the start input', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    const spy = vi.spyOn(api.rpc.backup, 'start');
    renderWithApp(
      <BackupDialogBody
        connectionId={localConnectionId}
        database="shop"
        onClose={() => undefined}
      />,
      { api },
    );
    await waitFor(() => expect(screen.getByTestId('estimate')).toBeInTheDocument());
    await chooseFolder();
    fireEvent.click(screen.getByRole('button', { name: 'Start backup' }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: localConnectionId,
        scope: { kind: 'database', database: 'shop' },
        options: expect.objectContaining({ output: 'archive', gzip: true }),
        toolsVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        acknowledged: [],
      }),
    );
  });

  it('keeps Start disabled for a strong finding until it is acknowledged', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    const real = api.rpc.backup.describeServer.bind(api.rpc.backup);
    vi.spyOn(api.rpc.backup, 'describeServer').mockImplementation(async (input) => {
      const info = await real(input);
      return {
        ...info,
        namespaces: info.namespaces.map((item, index) =>
          index === 0 ? { ...item, encrypted: true } : item,
        ),
      };
    });
    renderWithApp(
      <BackupDialogBody
        connectionId={localConnectionId}
        database="shop"
        onClose={() => undefined}
      />,
      { api },
    );
    await chooseFolder();
    const checkbox = await screen.findByLabelText('I understand');
    expect(screen.getByRole('button', { name: 'Start backup' })).toBeDisabled();
    fireEvent.click(checkbox);
    expect(screen.getByRole('button', { name: 'Start backup' })).toBeEnabled();
  });

  it('keeps Start disabled until the selected scope has been described', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    const real = api.rpc.backup.describeServer.bind(api.rpc.backup);
    vi.spyOn(api.rpc.backup, 'describeServer').mockImplementation((input) =>
      input.scope === undefined ? real(input) : new Promise(() => undefined),
    );
    renderWithApp(
      <BackupDialogBody
        connectionId={localConnectionId}
        database="shop"
        onClose={() => undefined}
      />,
      { api },
    );
    await chooseFolder();
    expect(screen.getByRole('button', { name: 'Start backup' })).toBeDisabled();
  });

  it('keeps Start disabled and shows the error when the scope cannot be described', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    const real = api.rpc.backup.describeServer.bind(api.rpc.backup);
    vi.spyOn(api.rpc.backup, 'describeServer').mockImplementation((input) =>
      input.scope === undefined ? real(input) : Promise.reject(new Error('listCollections failed')),
    );
    renderWithApp(
      <BackupDialogBody
        connectionId={localConnectionId}
        database="shop"
        onClose={() => undefined}
      />,
      { api },
    );
    await chooseFolder();
    await screen.findByText(/listCollections failed/);
    expect(screen.getByRole('button', { name: 'Start backup' })).toBeDisabled();
  });

  it('drops exclude prefixes once the scope is the whole server', async () => {
    const api = await renderDialog();
    const spy = vi.spyOn(api.rpc.backup, 'start');
    const prefixes = screen.getByRole('textbox', { name: /^Exclude prefixes/ });
    fireEvent.change(prefixes, { target: { value: 'tmp_' } });
    fireEvent.keyDown(prefixes, { key: 'Enter' });
    expect(screen.getByText('tmp_')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Databases' }), { key: 'Backspace' });
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: /^Exclude prefixes/ })).toBeNull(),
    );
    await chooseFolder();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start backup' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start backup' }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: 'server' },
        options: expect.not.objectContaining({ excludeCollectionsWithPrefix: ['tmp_'] }),
      }),
    );
  });

  it('drops the query once the target is no longer a collection', async () => {
    await renderDialog({ database: 'shop', collection: 'orders' });
    fireEvent.change(screen.getByLabelText('Query'), { target: { value: '{"status": "paid"}' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Server or databases' }));
    await chooseFolder();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start backup' })).toBeEnabled());
  });
});
