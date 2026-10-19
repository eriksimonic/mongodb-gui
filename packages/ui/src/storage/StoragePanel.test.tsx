// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { connectedMockApi } from '../api/connected-mock';
import { localConnectionId } from '../api/mock-fixtures';
import { formatBytes } from '../diagnostics/format';
import { renderWithApp } from '../test-support/render';
import { StoragePanel } from './StoragePanel';

const MB = 1024 * 1024;

describe('StoragePanel', () => {
  it('shows the databases, then the collections of a clicked database', async () => {
    const api = await connectedMockApi();
    renderWithApp(<StoragePanel connectionId={localConnectionId} />, { api });

    expect(await screen.findByTestId('storage-row-shop')).toBeInTheDocument();
    expect(screen.getByTestId('storage-row-analytics')).toBeInTheDocument();
    expect(screen.getByTestId('storage-row-logs')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('storage-row-shop'));

    expect(await screen.findByTestId('storage-row-orders')).toBeInTheDocument();
    expect(await screen.findByTestId('storage-row-customers')).toBeInTheDocument();
    expect(screen.getByTestId('storage-row-carts')).toBeInTheDocument();
  });

  it('shows the indexes of a clicked collection', async () => {
    const api = await connectedMockApi();
    renderWithApp(<StoragePanel connectionId={localConnectionId} />, { api });

    fireEvent.click(await screen.findByTestId('storage-row-shop'));
    fireEvent.click(await screen.findByTestId('storage-row-orders'));

    expect(await screen.findByTestId('storage-tile-data')).toBeInTheDocument();
    expect(screen.getByTestId('storage-tile-free')).toBeInTheDocument();
    expect(screen.getByTestId('storage-tile-index:_id_')).toBeInTheDocument();
    expect(await screen.findByTestId('storage-row-legacyRef_1')).toBeInTheDocument();
    // Indexes under 2% of the bar merge into one segment.
    expect(screen.getByTestId('storage-tile-more')).toBeInTheDocument();
    expect(screen.getByTestId('storage-index-bar')).toBeInTheDocument();
  });

  it('shows the metric switch only at the collections level', async () => {
    const api = await connectedMockApi();
    renderWithApp(<StoragePanel connectionId={localConnectionId} />, { api });

    await screen.findByTestId('storage-row-shop');
    expect(screen.queryByLabelText('Data size')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('storage-row-shop'));
    await screen.findByTestId('storage-row-orders');
    expect(screen.getByLabelText('Data size')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('storage-row-orders'));
    await screen.findByTestId('storage-tile-data');
    expect(screen.queryByLabelText('Data size')).not.toBeInTheDocument();
  });

  it('goes up one level on Backspace from the index level', async () => {
    const api = await connectedMockApi();
    renderWithApp(<StoragePanel connectionId={localConnectionId} />, { api });

    fireEvent.click(await screen.findByTestId('storage-row-shop'));
    fireEvent.click(await screen.findByTestId('storage-row-orders'));
    fireEvent.keyDown(await screen.findByTestId('storage-tile-data'), { key: 'Backspace' });

    expect(await screen.findByTestId('storage-row-carts')).toBeInTheDocument();
  });

  it('lists an index with zero operations in the unused card', async () => {
    const api = await connectedMockApi();
    renderWithApp(<StoragePanel connectionId={localConnectionId} />, { api });

    fireEvent.click(await screen.findByTestId('storage-row-shop'));

    // legacyRef_1 is also in the biggest-indexes card, so scope to the unused card.
    const unused = (await screen.findByText('Unused indexes')).parentElement as HTMLElement;
    expect(within(unused).getByText('shop.orders legacyRef_1')).toBeInTheDocument();
    expect(within(unused).getByText('shop.products sku_1')).toBeInTheDocument();
  });

  it('shows the error of a collection whose stats could not be read', async () => {
    const api = await connectedMockApi();
    renderWithApp(<StoragePanel connectionId={localConnectionId} />, { api });

    fireEvent.click(await screen.findByTestId('storage-row-analytics'));

    const row = await screen.findByTestId('storage-row-archive');
    expect(within(row).getByText('not authorized')).toBeInTheDocument();
  });

  it('changes the size shown in the size column when the metric changes', async () => {
    const api = await connectedMockApi();
    renderWithApp(<StoragePanel connectionId={localConnectionId} />, { api });

    fireEvent.click(await screen.findByTestId('storage-row-shop'));
    const tile = (await screen.findByTestId('storage-row-orders')).closest('[role="row"]') as HTMLElement;
    expect(within(tile).getAllByText(formatBytes(640 * MB)).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText('Data size'));

    expect(within(tile).getAllByText(formatBytes(1900 * MB)).length).toBeGreaterThan(0);
  });

  it('opens focused on the database given in focusDatabase', async () => {
    const api = await connectedMockApi();
    renderWithApp(<StoragePanel connectionId={localConnectionId} focusDatabase="logs" />, { api });

    expect(await screen.findByTestId('storage-row-app')).toBeInTheDocument();
    expect(screen.getByTestId('storage-row-access')).toBeInTheDocument();
  });
});
