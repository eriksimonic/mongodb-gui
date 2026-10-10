// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
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

  it('labels the footer button from the dry run checkbox', async () => {
    await renderDialog();
    await chooseArchive();
    fireEvent.click(screen.getByLabelText('Dry run'));
    expect(screen.getByRole('button', { name: 'Run dry run' })).toBeInTheDocument();
  });
});
