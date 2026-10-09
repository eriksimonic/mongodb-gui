// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { ManagementDialogs } from '../management/ManagementDialogs';
import { TransferModals } from '../transfers/TransferModals';
import { renderWithApp } from '../../test-support/render';
import { connectedMockApi } from '../../api/connected-mock';
import { ConnectionTree } from './ConnectionTree';

/** Renders the tree with the management dialog host and opens shop, so its collections show. */
async function renderTreeWithShopOpen() {
  const api = await connectedMockApi();
  const result = renderWithApp(
    <>
      <ConnectionTree />
      <ManagementDialogs />
    </>,
    { api },
  );
  const local = await screen.findByRole('treeitem', { name: 'Local dev' });
  local.focus();
  fireEvent.keyDown(local, { key: 'ArrowRight' });
  const shop = await screen.findByRole('treeitem', { name: 'shop' });
  shop.focus();
  fireEvent.keyDown(shop, { key: 'ArrowRight' });
  await screen.findByRole('treeitem', { name: 'orders' });
  return { ...result, api, local, shop };
}

describe('tree context menus for databases and collections', () => {
  it('offers new collection, drop database and refresh on a database', async () => {
    const { shop } = await renderTreeWithShopOpen();
    fireEvent.contextMenu(shop);

    expect(await screen.findByText('New collection')).toBeInTheDocument();
    expect(screen.getByText('Drop database')).toBeInTheDocument();
    expect(screen.getByText('Refresh')).toBeInTheDocument();
  });

  it('opens the new collection dialog for the database that was clicked', async () => {
    const { shop } = await renderTreeWithShopOpen();
    fireEvent.contextMenu(shop);
    fireEvent.click(await screen.findByText('New collection'));

    expect(await screen.findByText('New collection in shop')).toBeInTheDocument();
  });

  it('offers the collection actions on a collection and opens the drop confirmation', async () => {
    await renderTreeWithShopOpen();
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'customers' }));

    for (const label of [
      'Open documents',
      'Indexes',
      'Validation',
      'Rename',
      'Clear',
      'Drop',
      'Refresh',
    ]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByText('Drop'));

    expect(await screen.findByLabelText('Type customers to confirm')).toBeInTheDocument();
  });

  it('offers new database on a connected connection', async () => {
    const { local } = await renderTreeWithShopOpen();
    fireEvent.contextMenu(local);
    fireEvent.click(await screen.findByText('New database'));

    expect(await screen.findByLabelText('Database name')).toBeInTheDocument();
  });
});

describe('ConnectionTree catalog refresh', () => {
  it('shows a collection created through the api without a manual refresh', async () => {
    const { api, shop } = await renderTreeWithShopOpen();
    expect(shop).toBeInTheDocument();

    await api.rpc.management.createCollection({
      connectionId: localConnectionId,
      database: 'shop',
      name: 'refunds',
    });

    expect(await screen.findByRole('treeitem', { name: 'refunds' })).toBeInTheDocument();
  });

  it('removes a dropped collection from the tree', async () => {
    const { api } = await renderTreeWithShopOpen();
    expect(screen.getByRole('treeitem', { name: 'paid_orders' })).toBeInTheDocument();

    await api.rpc.management.dropCollection({
      connectionId: localConnectionId,
      database: 'shop',
      name: 'paid_orders',
    });

    await waitFor(() =>
      expect(screen.queryByRole('treeitem', { name: 'paid_orders' })).not.toBeInTheDocument(),
    );
  });
});

describe('tree context menus for transfers', () => {
  /** Renders the tree with the transfer dialogs and the management dialogs, and opens shop. */
  async function renderWithTransfers() {
    const api = await connectedMockApi();
    renderWithApp(
      <>
        <ConnectionTree />
        <ManagementDialogs />
        <TransferModals />
      </>,
      { api },
    );
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    local.focus();
    fireEvent.keyDown(local, { key: 'ArrowRight' });
    const shop = await screen.findByRole('treeitem', { name: 'shop' });
    shop.focus();
    fireEvent.keyDown(shop, { key: 'ArrowRight' });
    return { shop, orders: await screen.findByRole('treeitem', { name: 'orders' }) };
  }

  it('offers import and export on a collection and opens the export dialog', async () => {
    const { orders } = await renderWithTransfers();
    fireEvent.contextMenu(orders);

    expect(await screen.findByText('Import data')).toBeInTheDocument();
    fireEvent.click(await screen.findByText('Export data'));

    const dialog = await screen.findByRole('dialog', { name: 'Export data' });
    expect(dialog).toHaveTextContent('shop.orders');
  });

  it('opens the import wizard on a collection', async () => {
    const { orders } = await renderWithTransfers();
    fireEvent.contextMenu(orders);
    fireEvent.click(await screen.findByText('Import data'));

    const dialog = await screen.findByRole('dialog', { name: 'Import data' });
    expect(within(dialog).getByLabelText('File path')).toBeInTheDocument();
  });

  it('offers only a new collection import on a database', async () => {
    const { shop } = await renderWithTransfers();
    fireEvent.contextMenu(shop);

    expect(await screen.findByText('Import data into new collection')).toBeInTheDocument();
    expect(screen.queryByText('Export data')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Import data into new collection'));

    await waitFor(() => expect(screen.getByLabelText('New collection name')).toBeInTheDocument());
  });
});
