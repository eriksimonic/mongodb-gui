// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { localConnectionId } from '../../api/mock-fixtures';
import { mockSavePath } from '../../api/mock-transfer';
import type { UiApi } from '../../api/ui-api';
import { renderWithApp } from '../../test-support/render';
import { ExportDialogBody } from './ExportDialog';

/** The save dialog returns the default NDJSON file for the default format. */
const MOCK_DIALOG_PATH = mockSavePath('ndjson');

async function connectedApi(): Promise<UiApi> {
  const api = createMockUiApi({ preset: 'unlocked' });
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

async function renderDialog(onClose = () => undefined) {
  const api = await connectedApi();
  renderWithApp(
    <ExportDialogBody
      connectionId={localConnectionId}
      database="shop"
      collection="orders"
      onClose={onClose}
    />,
    { api },
  );
  return api;
}

describe('ExportDialog', () => {
  it('keeps Start export disabled until a file is chosen with the save dialog', async () => {
    await renderDialog();
    expect(screen.getByRole('button', { name: 'Start export' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Save as' }));
    await waitFor(() => expect(screen.getByLabelText('File')).toHaveValue(MOCK_DIALOG_PATH));
    expect(screen.getByRole('button', { name: 'Start export' })).toBeEnabled();
  });

  it('names the file the save dialog suggests after the database, collection and format', async () => {
    const api = await connectedApi();
    const spy = vi.spyOn(api.rpc.app, 'showSaveDialog');
    renderWithApp(
      <ExportDialogBody
        connectionId={localConnectionId}
        database="shop"
        collection="orders"
        onClose={() => undefined}
      />,
      { api },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save as' }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'shop.orders.ndjson' }),
    );
  });

  it('refuses a filter that is not extended JSON and says why', async () => {
    await renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Save as' }));
    await waitFor(() => expect(screen.getByLabelText('File')).toHaveValue(MOCK_DIALOG_PATH));

    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'ObjectId("65b0")' } });
    expect(screen.getByText(/The filter is not valid extended JSON/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start export' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: '{"status": "paid"}' } });
    expect(screen.getByRole('button', { name: 'Start export' })).toBeEnabled();
  });

  it('shows the CSV options only for CSV', async () => {
    await renderDialog();
    expect(screen.queryByLabelText('CSV options')).not.toBeInTheDocument();
    expect(screen.getByLabelText('EJSON mode')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Format', { selector: 'input' }));
    fireEvent.click(screen.getByRole('option', { name: 'CSV' }));
    expect(screen.getByLabelText('CSV options')).toBeInTheDocument();
    expect(screen.queryByLabelText('EJSON mode')).not.toBeInTheDocument();
  });

  it('exports, shows the summary, and reveals the written file', async () => {
    const api = await renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Save as' }));
    await waitFor(() => expect(screen.getByLabelText('File')).toHaveValue(MOCK_DIALOG_PATH));
    const reveal = vi.spyOn(api.rpc.app, 'showItemInFolder');

    fireEvent.click(screen.getByRole('button', { name: 'Start export' }));
    expect(await screen.findByTestId('transfer-progress')).toBeInTheDocument();
    const summary = await screen.findByTestId('export-summary', undefined, { timeout: 4000 });
    expect(summary).toHaveTextContent(`Exported 300 documents to ${MOCK_DIALOG_PATH}.`);

    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }));
    await waitFor(() => expect(reveal).toHaveBeenCalledWith({ path: MOCK_DIALOG_PATH }));
  });

  it('cancels a running export and reports that the partial file was removed', async () => {
    await renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Save as' }));
    await waitFor(() => expect(screen.getByLabelText('File')).toHaveValue(MOCK_DIALOG_PATH));
    fireEvent.click(screen.getByRole('button', { name: 'Start export' }));

    await screen.findByTestId('transfer-progress');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const summary = await screen.findByTestId('export-summary', undefined, { timeout: 4000 });
    expect(summary).toHaveTextContent('The export was cancelled and the partial file was removed.');
    expect(screen.queryByRole('button', { name: 'Show in folder' })).not.toBeInTheDocument();
  });
});
