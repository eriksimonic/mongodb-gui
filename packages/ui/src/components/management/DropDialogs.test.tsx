// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { renderWithApp } from '../../test-support/render';
import { connectedMockApi } from '../../api/connected-mock';
import { ClearCollectionDialog, DropCollectionDialog, DropDatabaseDialog } from './DropDialogs';

const target = { connectionId: localConnectionId, database: 'shop' };

describe('DropCollectionDialog', () => {
  it('keeps the drop button disabled until the typed name matches exactly', async () => {
    const api = await connectedMockApi();
    renderWithApp(<DropCollectionDialog {...target} collection="customers" onClose={vi.fn()} />, {
      api,
    });
    const drop = screen.getByRole('button', { name: 'Drop collection' });
    const typed = screen.getByLabelText('Type customers to confirm');

    fireEvent.change(typed, { target: { value: 'custmers' } });
    expect(drop).toBeDisabled();
    fireEvent.change(typed, { target: { value: 'Customers' } });
    expect(drop).toBeDisabled();
    fireEvent.change(typed, { target: { value: 'customers' } });
    expect(drop).toBeEnabled();
  });

  it('drops the collection from the server catalog once confirmed', async () => {
    const api = await connectedMockApi();
    const onClose = vi.fn();
    renderWithApp(<DropCollectionDialog {...target} collection="customers" onClose={onClose} />, {
      api,
    });
    fireEvent.change(screen.getByLabelText('Type customers to confirm'), {
      target: { value: 'customers' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Drop collection' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const names = (
      await api.rpc.collections.list({ ...target, connectionId: localConnectionId })
    ).map((item) => item.name);
    expect(names).not.toContain('customers');
  });
});

describe('DropDatabaseDialog', () => {
  it('requires the database name before the drop is enabled', async () => {
    const api = await connectedMockApi();
    renderWithApp(
      <DropDatabaseDialog connectionId={localConnectionId} database="logs" onClose={vi.fn()} />,
      {
        api,
      },
    );
    expect(screen.getByRole('button', { name: 'Drop database' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type logs to confirm'), { target: { value: 'logs' } });
    expect(screen.getByRole('button', { name: 'Drop database' })).toBeEnabled();
  });
});

describe('DropDatabaseDialog reporting', () => {
  it('reports the drop once the server has dropped the database', async () => {
    const api = await connectedMockApi();
    const onDropped = vi.fn();
    const onClose = vi.fn();
    renderWithApp(
      <DropDatabaseDialog
        connectionId={localConnectionId}
        database="logs"
        onClose={onClose}
        onDropped={onDropped}
      />,
      { api },
    );
    fireEvent.change(screen.getByLabelText('Type logs to confirm'), { target: { value: 'logs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Drop database' }));

    await waitFor(() => expect(onDropped).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    const names = (await api.rpc.databases.list({ connectionId: localConnectionId })).map(
      (item) => item.name,
    );
    expect(names).not.toContain('logs');
  });
});

describe('ClearCollectionDialog', () => {
  it('shows the current document count from the stats before it allows the clear', async () => {
    const api = await connectedMockApi();
    const onClose = vi.fn();
    renderWithApp(<ClearCollectionDialog {...target} collection="customers" onClose={onClose} />, {
      api,
    });

    expect(
      await screen.findByText(/Delete all 240 documents in shop.customers/),
    ).toBeInTheDocument();
    const clear = screen.getByRole('button', { name: 'Clear collection' });
    await waitFor(() => expect(clear).toBeEnabled());
    fireEvent.click(clear);

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const stats = await api.rpc.collections.stats({
      connectionId: localConnectionId,
      database: 'shop',
      collection: 'customers',
    });
    expect(stats.count).toBe(0);
  });
});
