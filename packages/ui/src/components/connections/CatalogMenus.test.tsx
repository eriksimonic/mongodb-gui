// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { ManagementDialogs } from '../management/ManagementDialogs';
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
