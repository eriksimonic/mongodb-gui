// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppErrorException, appError } from '@mongo-gui/core';
import { renderWithApp } from '../../test-support/render';
import { ConnectionsExportModal } from './ConnectionsExportModal';

const PASSPHRASE = 'export passphrase';

function renderExport(onClose = () => undefined) {
  return renderWithApp(<ConnectionsExportModal opened onClose={onClose} />, {
    mock: { preset: 'unlocked' },
  });
}

async function fillPassphrase(passphrase: string, confirmation = passphrase) {
  fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: passphrase } });
  fireEvent.change(screen.getByLabelText('Confirm passphrase'), {
    target: { value: confirmation },
  });
}

describe('ConnectionsExportModal', () => {
  it('lists every connection with a checkbox that starts checked', async () => {
    renderExport();
    const names = await screen.findAllByRole('checkbox');
    expect(names.length).toBeGreaterThan(1);
    for (const checkbox of names) {
      expect(checkbox).toBeChecked();
    }
  });

  it('shows the minimum length hint and refuses a short passphrase without saving', async () => {
    const { api } = renderExport();
    const save = vi.spyOn(api.rpc.app, 'showSaveDialog');
    await screen.findAllByRole('checkbox');
    expect(screen.getByText(/At least 10 characters/)).toBeInTheDocument();

    await fillPassphrase('short');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(await screen.findByText('The passphrase must be at least 10 characters.')).toBeVisible();
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a confirmation that does not match', async () => {
    const { api } = renderExport();
    const save = vi.spyOn(api.rpc.app, 'showSaveDialog');
    await screen.findAllByRole('checkbox');

    await fillPassphrase(PASSPHRASE, `${PASSPHRASE}!`);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(await screen.findByText('The passphrases do not match.')).toBeVisible();
    expect(save).not.toHaveBeenCalled();
  });

  it('exports the selected connections to the file the save dialog returned', async () => {
    const { api } = renderExport();
    const exported = vi.spyOn(api.rpc.connections, 'exportToFile');
    const all = await screen.findAllByRole('checkbox');
    const [first] = all;
    if (first === undefined) {
      throw new Error('no connection checkbox');
    }
    fireEvent.click(first);
    const expectedIds = (await api.rpc.connections.list())
      .map((connection) => connection.id)
      .filter((id) => id !== first.getAttribute('value'));

    await fillPassphrase(PASSPHRASE);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    const notice = await screen.findByRole('status');
    expect(within(notice).getByText('Connections exported')).toBeInTheDocument();
    expect(notice).toHaveTextContent('/mock/orders.mgconn');
    expect(exported).toHaveBeenCalledWith({
      profileIds: expectedIds,
      passphrase: PASSPHRASE,
      path: '/mock/orders.mgconn',
    });
  });

  it('writes nothing when the save dialog is cancelled', async () => {
    const { api } = renderExport();
    vi.spyOn(api.rpc.app, 'showSaveDialog').mockResolvedValueOnce({});
    const exported = vi.spyOn(api.rpc.connections, 'exportToFile');
    await screen.findAllByRole('checkbox');

    await fillPassphrase(PASSPHRASE);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled());
    expect(exported).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows a red alert with the adapter message when the export fails', async () => {
    const { api } = renderExport();
    vi.spyOn(api.rpc.connections, 'exportToFile').mockRejectedValueOnce(
      new AppErrorException(appError('VALIDATION', 'The folder does not exist.')),
    );
    await screen.findAllByRole('checkbox');

    await fillPassphrase(PASSPHRASE);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The folder does not exist.');
  });

  it('keeps the export disabled while no connection is selected', async () => {
    const { api } = renderExport();
    const exported = vi.spyOn(api.rpc.connections, 'exportToFile');
    const all = await screen.findAllByRole('checkbox');
    for (const checkbox of all) {
      fireEvent.click(checkbox);
    }

    await fillPassphrase(PASSPHRASE);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(await screen.findByText('Select at least one connection.')).toBeVisible();
    expect(exported).not.toHaveBeenCalled();
  });
});
