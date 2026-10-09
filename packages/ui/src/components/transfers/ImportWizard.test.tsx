// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { localConnectionId } from '../../api/mock-fixtures';
import { MOCK_DIALOG_PATH } from '../../api/mock-transfer';
import type { UiApi } from '../../api/ui-api';
import { renderWithApp } from '../../test-support/render';
import { ImportWizardBody } from './ImportWizard';

const SUMMARY_TIMEOUT_MS = 6000;

async function connectedApi(): Promise<UiApi> {
  const api = createMockUiApi({ preset: 'unlocked' });
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

/** Opens a Mantine select and picks one of its options. */
function chooseOption(label: string, option: string) {
  fireEvent.click(screen.getByLabelText(label, { selector: 'input' }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

/** Renders the wizard for shop.orders and moves it to the mapping step with the mock file. */
async function renderAtMapping(onClose = vi.fn()) {
  const api = await connectedApi();
  renderWithApp(
    <ImportWizardBody
      connectionId={localConnectionId}
      database="shop"
      collection="orders"
      onClose={onClose}
    />,
    { api },
  );
  fireEvent.change(screen.getByLabelText('File path'), { target: { value: MOCK_DIALOG_PATH } });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('table', { name: 'Field mapping' });
  return { api, onClose };
}

describe('ImportWizard, step one: choose file', () => {
  it('fills the path from the file dialog and shows the CSV options for a CSV file', async () => {
    const api = await connectedApi();
    renderWithApp(
      <ImportWizardBody
        connectionId={localConnectionId}
        database="shop"
        collection="orders"
        onClose={vi.fn()}
      />,
      { api },
    );
    expect(screen.queryByLabelText('CSV options')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    await waitFor(() => expect(screen.getByLabelText('File path')).toHaveValue(MOCK_DIALOG_PATH));
    expect(screen.getByLabelText('CSV options')).toBeInTheDocument();
    expect(screen.getByLabelText('Null values')).toHaveValue('null, NULL');
    expect(screen.getByText('Target: shop.orders')).toBeInTheDocument();
  });

  it('refuses a relative path before it asks the backend for a preview', async () => {
    const api = await connectedApi();
    renderWithApp(
      <ImportWizardBody
        connectionId={localConnectionId}
        database="shop"
        collection="orders"
        onClose={vi.fn()}
      />,
      { api },
    );
    fireEvent.change(screen.getByLabelText('File path'), { target: { value: 'orders.csv' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose a file or type its full path',
    );
    expect(screen.queryByRole('table', { name: 'Field mapping' })).not.toBeInTheDocument();
  });

  it('asks for a name when the collection is new', async () => {
    const api = await connectedApi();
    renderWithApp(
      <ImportWizardBody
        connectionId={localConnectionId}
        database="shop"
        collection={undefined}
        onClose={vi.fn()}
      />,
      { api },
    );
    fireEvent.change(screen.getByLabelText('File path'), { target: { value: MOCK_DIALOG_PATH } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Name the new collection');
    fireEvent.change(screen.getByLabelText('New collection name'), {
      target: { value: 'archive' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('table', { name: 'Field mapping' });
  });
});

describe('ImportWizard, step two: preview and mapping', () => {
  it('shows the warnings, the sample rows and one line per field', async () => {
    await renderAtMapping();

    expect(screen.getByText('Column 6 has no name and is called column_6')).toBeInTheDocument();
    expect(screen.getByLabelText('Target for order_id')).toHaveValue('order_id');
    expect(screen.getByLabelText('Type for total', { selector: 'input' })).toHaveValue('double');
    const sample = screen.getByRole('table', { name: 'Sample rows' });
    expect(sample).toHaveTextContent('ord-1001');
    expect(sample).toHaveTextContent('null');
  });

  it('renames a target and keeps Next enabled', async () => {
    await renderAtMapping();
    fireEvent.change(screen.getByLabelText('Target for total'), { target: { value: 'amount' } });

    expect(screen.getByLabelText('Target for total')).toHaveValue('amount');
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('blocks Next while two fields share a target, then allows it once they differ', async () => {
    await renderAtMapping();
    fireEvent.change(screen.getByLabelText('Target for total'), { target: { value: 'order_id' } });

    expect(screen.getByText('Two fields are mapped to "order_id"')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Target for total'), { target: { value: 'amount' } });
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('skips a field: its target and type are disabled and it leaves the sample table', async () => {
    await renderAtMapping();
    fireEvent.click(screen.getByLabelText('Skip status'));

    expect(screen.getByLabelText('Skip status')).toBeChecked();
    expect(screen.getByLabelText('Target for status')).toBeDisabled();
    const sample = screen.getByRole('table', { name: 'Sample rows' });
    expect(sample).not.toHaveTextContent('refunded');
  });

  it('blocks Next when every field is skipped', async () => {
    await renderAtMapping();
    for (const name of ['order_id', 'customer', 'total', 'placed_at', 'status']) {
      fireEvent.click(screen.getByLabelText(`Skip ${name}`));
    }
    expect(screen.getByText('Map at least one field')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});

describe('ImportWizard, step three: options and run', () => {
  it('asks for an upsert key only in upsert mode and blocks the start while it is empty', async () => {
    await renderAtMapping();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.queryByLabelText('Upsert key')).not.toBeInTheDocument();

    chooseOption('Mode', 'Replace documents that match the upsert key, or insert them');
    const key = screen.getByLabelText('Upsert key');
    fireEvent.change(key, { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Start import' })).toBeDisabled();

    fireEvent.change(key, { target: { value: 'order_id' } });
    expect(screen.getByRole('button', { name: 'Start import' })).toBeEnabled();
  });

  it('rejects a batch size outside the allowed range', async () => {
    await renderAtMapping();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('Batch size'), { target: { value: '0' } });

    expect(screen.getByRole('button', { name: 'Start import' })).toBeDisabled();
  });

  it('runs the import with live progress and cancel, and reports the cancelled run', async () => {
    const { onClose } = await renderAtMapping();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start import' }));

    expect(await screen.findByTestId('transfer-progress')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    const summary = await screen.findByTestId('import-summary', undefined, {
      timeout: SUMMARY_TIMEOUT_MS,
    });
    expect(summary).toHaveTextContent('The import was cancelled.');
    fireEvent.click(screen.getByRole('button', { name: 'Open collection' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the counts, the first errors and the summary of a finished import', async () => {
    await renderAtMapping();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start import' }));

    const summary = await screen.findByTestId('import-summary', undefined, {
      timeout: SUMMARY_TIMEOUT_MS,
    });
    expect(summary).toHaveTextContent(
      'Inserted 238, updated 0, failed 2 of 240 records into shop.orders.',
    );
    const errors = screen.getByRole('table', { name: 'Row errors' });
    expect(errors).toHaveTextContent('"n/a" is not a number');
    expect(
      screen.getByText('Row numbers count data records, not lines in the file.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy all' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Import another' }));
    expect(screen.getByLabelText('File path')).toHaveValue('');
  });
});
