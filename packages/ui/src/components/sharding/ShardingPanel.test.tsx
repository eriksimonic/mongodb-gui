// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { renderWithApp } from '../../test-support/render';
import { ShardingPanel } from './ShardingPanel';

async function clusterApi() {
  const api = createMockUiApi({ preset: 'unlocked', sharding: 'cluster' });
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

/** The row of a shard, database or collection, found by its first cell's text. */
async function rowOf(text: string): Promise<HTMLElement> {
  const row = (await screen.findByText(text)).closest('tr');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe('ShardingPanel', () => {
  it('loads the overview with the balancer state and the shards', async () => {
    const api = await clusterApi();
    renderWithApp(<ShardingPanel connectionId={localConnectionId} />, { api });

    expect(await screen.findByText('Balancer on')).toBeInTheDocument();
    expect(screen.getByText('window 23:00 to 06:00 (wraps midnight)')).toBeInTheDocument();
    const shard = await rowOf('rs-b/localhost:27019');
    expect(within(shard).getByText('shard-b')).toBeInTheDocument();
    expect(within(shard).getByText('eu')).toBeInTheDocument();
  });

  it('stops the balancer only after the confirmation', async () => {
    const api = await clusterApi();
    const stop = vi.spyOn(api.rpc.sharding, 'setBalancer');
    renderWithApp(<ShardingPanel connectionId={localConnectionId} />, { api });
    await screen.findByText('Balancer on');

    fireEvent.click(screen.getByRole('button', { name: 'Stop balancer' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/No chunks move between shards/)).toBeInTheDocument();
    expect(stop).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop balancer' }));
    expect(await screen.findByText('Balancer off')).toBeInTheDocument();
    expect(stop).toHaveBeenCalledWith({ connectionId: localConnectionId, enabled: false });
    expect(screen.getByRole('button', { name: 'Start balancer' })).toBeEnabled();
  });

  it('enables sharding on a database only after the confirmation', async () => {
    const api = await clusterApi();
    const enable = vi.spyOn(api.rpc.sharding, 'enableSharding');
    renderWithApp(<ShardingPanel connectionId={localConnectionId} />, { api });
    await screen.findByText('Balancer on');

    fireEvent.click(screen.getByRole('tab', { name: 'Databases' }));
    const row = await rowOf('analytics');
    fireEvent.click(within(row).getByRole('button', { name: 'Enable sharding' }));
    const dialog = await screen.findByRole('dialog');
    expect(enable).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Enable sharding' }));
    await waitFor(() => {
      expect(enable).toHaveBeenCalledWith({
        connectionId: localConnectionId,
        database: 'analytics',
      });
    });
    await waitFor(() => {
      const current = screen.getByText('analytics').closest('tr');
      expect(current).not.toBeNull();
      expect(within(current as HTMLElement).getByText('Yes')).toBeInTheDocument();
    });
  });

  it('shows the distribution of one collection per shard', async () => {
    const api = await clusterApi();
    renderWithApp(<ShardingPanel connectionId={localConnectionId} />, { api });
    await screen.findByText('Balancer on');

    fireEvent.click(screen.getByRole('tab', { name: 'Collections' }));
    // The zones tab also names shop.orders, so the search stays inside the visible panel.
    const tabPanel = await screen.findByRole('tabpanel');
    const row = within(tabPanel).getByText('shop.orders').closest('tr') as HTMLElement;
    expect(within(row).getByText('shard-a 9, shard-b 4')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Distribution' }));
    const dialog = await screen.findByRole('dialog', { name: 'Distribution of shop.orders' });
    expect(await within(dialog).findByText('shard-b')).toBeInTheDocument();
  });

  it('says sharding is not available on a standalone server', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    renderWithApp(<ShardingPanel connectionId={localConnectionId} />, { api });

    expect(await screen.findByText('Sharding is not available')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Shards' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop balancer' })).not.toBeInTheDocument();
  });
});
