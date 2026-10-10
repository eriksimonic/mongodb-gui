// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
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
});
