// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { RestoreOptionsSchema } from '@mongo-gui/core';
import { describe, expect, it, vi } from 'vitest';
import { createMockUiApi, type MockUiApiOptions } from '../../api/mock-rpc-client';
import { localConnectionId } from '../../api/mock-fixtures';
import type { UiApi } from '../../api/ui-api';
import { renderWithApp } from '../../test-support/render';
import { RestoreDialogBody } from './RestoreDialog';

async function renderDialog(mock: MockUiApiOptions = { preset: 'unlocked' }): Promise<UiApi> {
  const api = createMockUiApi(mock);
  await api.rpc.connections.connect({ id: localConnectionId });
  renderWithApp(<RestoreDialogBody connectionId={localConnectionId} onClose={() => undefined} />, {
    api,
  });
  return api;
}

async function chooseArchive() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose archive…' }));
  await screen.findByTestId('restore-summary');
}

describe('RestoreDialog', () => {
  it('asks for a backup first', async () => {
    await renderDialog();
    expect(screen.getByText('Choose the backup to restore.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
  });

  it('opens the archive dialog with the backup filters and shows the summary', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    const spy = vi.spyOn(api.rpc.app, 'showOpenDialog');
    renderWithApp(
      <RestoreDialogBody connectionId={localConnectionId} onClose={() => undefined} />,
      { api },
    );
    await chooseArchive();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'Backups', extensions: ['archive', 'gz', 'agz', 'json'] }],
      }),
    );
    const summary = screen.getByTestId('restore-summary');
    expect(summary).toHaveTextContent('Local MongoDB');
    expect(summary).toHaveTextContent('7.0.14');
    expect(summary).toHaveTextContent('100.12.1');
    expect(screen.getByTestId('restore-contents')).toHaveTextContent('orders');
    expect(screen.getByTestId('restore-contents')).toHaveTextContent('time series');
  });

  it('sends a rename in the start input', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    const spy = vi.spyOn(api.rpc.backup, 'startRestore');
    renderWithApp(
      <RestoreDialogBody connectionId={localConnectionId} onClose={() => undefined} />,
      { api },
    );
    await chooseArchive();
    fireEvent.change(screen.getByLabelText('Restore shop as'), {
      target: { value: 'shop_copy' },
    });
    // The mock target is a newer server than the backup, so the block needs its name typed.
    const typed = screen.queryByLabelText(/^Type .* to restore anyway$/);
    if (typed !== null) {
      fireEvent.change(typed, { target: { value: 'Local dev' } });
    }
    for (const box of screen.queryAllByLabelText('I understand')) {
      fireEvent.click(box);
    }
    const button = screen.getByRole('button', { name: 'Restore' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ renames: [{ from: 'shop', to: 'shop_copy' }] }),
      }),
    );
  });

  it('needs the connection name typed for a confirmable block', async () => {
    await renderDialog();
    await chooseArchive();
    const input = await screen.findByLabelText('Type Local dev to restore anyway');
    for (const box of screen.queryAllByLabelText('I understand')) {
      fireEvent.click(box);
    }
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Local dev' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore' })).toBeEnabled());
  });

  it('keeps Restore disabled for the tools mismatch until it is acknowledged', async () => {
    await renderDialog({ preset: 'unlocked', tools: 'mismatch' });
    await chooseArchive();
    fireEvent.change(await screen.findByLabelText('Type Local dev to restore anyway'), {
      target: { value: 'Local dev' },
    });
    const checkbox = await screen.findByLabelText('I understand');
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
    fireEvent.click(checkbox);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore' })).toBeEnabled());
  });

  it('opens the download dialog from the mismatch finding', async () => {
    await renderDialog({ preset: 'unlocked', tools: 'mismatch' });
    await chooseArchive();
    fireEvent.click(await screen.findByRole('button', { name: 'Download 100.12.1' }));
    expect(await screen.findByText('Download MongoDB Database Tools')).toBeInTheDocument();
  });

  it('lists and selects the version a finding downloaded', async () => {
    await renderDialog({ preset: 'unlocked', tools: 'mismatch' });
    await chooseArchive();
    fireEvent.click(await screen.findByRole('button', { name: 'Download 100.12.1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Download MongoDB Database Tools' });
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox', { name: 'Version' })).toHaveValue('100.12.1'),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(
      () =>
        expect(screen.getByRole('textbox', { name: 'Tools version' })).toHaveValue(
          '100.12.1 (Downloaded)',
        ),
      { timeout: 4000 },
    );
    expect(screen.queryByRole('button', { name: 'Download 100.12.1' })).toBeNull();
  });

  it('picks the backup tools version when the tools list arrives after the backup', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    const real = api.rpc.backup.describeServer.bind(api.rpc.backup);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(api.rpc.backup, 'describeServer').mockImplementation(async (input) => {
      await gate;
      return real(input);
    });
    renderWithApp(
      <RestoreDialogBody connectionId={localConnectionId} onClose={() => undefined} />,
      { api },
    );
    await chooseArchive();
    release();
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Tools version' })).toHaveValue(
        '100.12.1 (Downloaded)',
      ),
    );
  });

  it('keeps Replay oplog on after a collection is unchecked and checked again', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    const inspect = api.rpc.backup.inspect.bind(api.rpc.backup);
    vi.spyOn(api.rpc.backup, 'inspect').mockImplementation(async (input) => ({
      ...(await inspect(input)),
      hasOplog: true,
    }));
    renderWithApp(
      <RestoreDialogBody connectionId={localConnectionId} onClose={() => undefined} />,
      { api },
    );
    await chooseArchive();
    const replay = screen.getByLabelText('Replay oplog');
    fireEvent.click(replay);
    expect(replay).toBeChecked();
    const box = within(screen.getByTestId('restore-contents')).getByLabelText('shop.orders');
    fireEvent.click(box);
    expect(screen.getByLabelText('Replay oplog')).not.toBeChecked();
    fireEvent.click(box);
    expect(screen.getByLabelText('Replay oplog')).toBeChecked();
  });

  it('labels the footer button from the dry run checkbox', async () => {
    await renderDialog();
    await chooseArchive();
    fireEvent.click(screen.getByLabelText('Dry run'));
    expect(screen.getByRole('button', { name: 'Run dry run' })).toBeInTheDocument();
  });

  it('saves the form, reopens it from the list and renames and deletes it', async () => {
    const api = await renderDialog();
    await chooseArchive();
    fireEvent.change(screen.getByLabelText('Restore shop as'), { target: { value: 'shop_copy' } });
    fireEvent.change(screen.getByLabelText('Saved restore name'), {
      target: { value: 'Nightly' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const row = await screen.findByRole('button', { name: 'Nightly' });
    const [saved] = await api.rpc.savedRestores.list();
    expect(saved?.options.renames).toEqual([{ from: 'shop', to: 'shop_copy' }]);

    fireEvent.change(screen.getByLabelText('Restore shop as'), { target: { value: 'other' } });
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByLabelText('Restore shop as')).toHaveValue('shop_copy'));

    fireEvent.click(screen.getByRole('button', { name: 'Rename Nightly' }));
    fireEvent.change(screen.getByLabelText('Rename Nightly'), { target: { value: 'Weekly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rename of Nightly' }));
    await screen.findByRole('button', { name: 'Weekly' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Weekly' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Weekly' })).toBeNull());
    expect(await api.rpc.savedRestores.list()).toEqual([]);
  });

  it('keeps the form and says so when the saved source is gone', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    const saved = await api.rpc.savedRestores.save({
      name: 'Old',
      connectionId: localConnectionId,
      source: '/backups/gone.archive',
      toolsVersion: '100.9.4',
      options: RestoreOptionsSchema.parse({}),
    });
    vi.spyOn(api.rpc.savedRestores, 'open').mockRejectedValue(
      Object.assign(new Error('The backup was not found.'), { code: 'NOT_FOUND' }),
    );
    renderWithApp(
      <RestoreDialogBody connectionId={localConnectionId} onClose={() => undefined} />,
      { api },
    );
    fireEvent.click(await screen.findByRole('button', { name: saved.name }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'cannot be opened from /backups/gone.archive',
    );
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
  });
});
