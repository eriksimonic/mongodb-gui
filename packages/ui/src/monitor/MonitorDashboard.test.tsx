// @vitest-environment jsdom
import type { ConnectionStatus, RpcEvent } from '@mongo-gui/core';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi, type MockUiApiOptions } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { renderWithApp } from '../test-support/render';
import { MonitorDashboard } from './MonitorDashboard';

const CONNECTED: ConnectionStatus = {
  state: 'connected',
  serverVersion: '8.0.4',
  topology: 'standalone',
  hosts: ['localhost:27017'],
};
const SEEDED = { statuses: { [localConnectionId]: CONNECTED } };
const LONG_TIMEOUT_MS = 10_000;

/** A mock api with the local connection already open, as the shell would leave it. */
async function connectedApi(options: MockUiApiOptions = { preset: 'unlocked' }): Promise<UiApi> {
  const api = createMockUiApi(options);
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

/** The value next to a stat tile label. */
function tileValue(label: string): string | null | undefined {
  return screen.getByText(label).nextElementSibling?.textContent;
}

describe('MonitorDashboard', () => {
  it(
    'renders the stat tiles and one chart container per card',
    async () => {
      const api = await connectedApi();
      renderWithApp(<MonitorDashboard connectionId={localConnectionId} />, {
        api,
        initialState: SEEDED,
      });

      expect(await screen.findByText('Uptime')).toBeInTheDocument();
      for (const label of ['Current connections', 'Cache fill', 'Operations per second']) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
      expect(screen.getAllByTestId('chart-card')).toHaveLength(5);
      expect(screen.getAllByTestId('chart-container')).toHaveLength(5);
      expect(screen.queryByText('Replication lag')).not.toBeInTheDocument();
      expect(screen.queryByText('Oplog window')).not.toBeInTheDocument();
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'adds the replication lag card and the oplog tile on a replica set',
    async () => {
      const api = await connectedApi({ preset: 'unlocked', replication: true });
      renderWithApp(<MonitorDashboard connectionId={localConnectionId} />, {
        api,
        initialState: SEEDED,
      });
      expect(await screen.findByText('Oplog window')).toBeInTheDocument();
      expect(screen.getByText('Replication lag')).toBeInTheDocument();
      expect(screen.getAllByTestId('chart-card')).toHaveLength(6);
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'updates the tiles when a new sample arrives',
    async () => {
      const api = await connectedApi();
      renderWithApp(<MonitorDashboard connectionId={localConnectionId} />, {
        api,
        initialState: SEEDED,
      });
      await screen.findByText('Operations per second');
      const before = tileValue('Operations per second');

      await waitFor(() => expect(tileValue('Operations per second')).not.toBe(before), {
        timeout: 6000,
      });
    },
    LONG_TIMEOUT_MS,
  );

  it('sends the chosen sampling interval to the api', async () => {
    const api = await connectedApi();
    const setInterval = vi.spyOn(api.rpc.monitor, 'setInterval');
    renderWithApp(<MonitorDashboard connectionId={localConnectionId} />, {
      api,
      initialState: SEEDED,
    });
    await screen.findByText('Operations per second');

    fireEvent.click(screen.getByRole('radio', { name: '5 s' }));

    await waitFor(() =>
      expect(setInterval).toHaveBeenCalledWith({
        connectionId: localConnectionId,
        intervalMs: 5000,
      }),
    );
  });

  it('freezes the view on pause and says so', async () => {
    const api = await connectedApi();
    renderWithApp(<MonitorDashboard connectionId={localConnectionId} />, {
      api,
      initialState: SEEDED,
    });
    await screen.findByText('Operations per second');

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByText(/· Paused$/)).toBeInTheDocument();
  });

  it('shows the waiting line when no samples have arrived yet', async () => {
    const base = await connectedApi();
    const api: UiApi = {
      rpc: { ...base.rpc, monitor: { ...base.rpc.monitor, samples: async () => [] } },
      onEvent: base.onEvent,
    };
    renderWithApp(<MonitorDashboard connectionId={localConnectionId} />, {
      api,
      initialState: SEEDED,
    });
    expect(await screen.findByText(/Waiting for the first sample/)).toBeInTheDocument();
  });

  it('shows the disconnected state with a connect action', async () => {
    renderWithApp(<MonitorDashboard connectionId={localConnectionId} />, {
      mock: { preset: 'unlocked' },
    });
    expect(await screen.findByText('The connection is disconnected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  it('shows a sampler error with its message and retries the sampler', async () => {
    const base = await connectedApi();
    const listeners = new Set<(event: RpcEvent) => void>();
    const api: UiApi = {
      rpc: base.rpc,
      onEvent(listener) {
        listeners.add(listener);
        const unsubscribe = base.onEvent(listener);
        return () => {
          listeners.delete(listener);
          unsubscribe();
        };
      },
    };
    const stop = vi.spyOn(base.rpc.monitor, 'stop');
    renderWithApp(<MonitorDashboard connectionId={localConnectionId} />, {
      api,
      initialState: SEEDED,
    });
    await screen.findByText('Operations per second');

    act(() => {
      for (const listener of listeners) {
        listener({
          type: 'monitor:error',
          connectionId: localConnectionId,
          error: { code: 'CONNECTION_FAILED', message: 'Server stopped responding' },
        });
      }
    });
    expect(await screen.findByText('Server stopped responding')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(stop).toHaveBeenCalledWith({ connectionId: localConnectionId }));
    await waitFor(() =>
      expect(screen.queryByText('Server stopped responding')).not.toBeInTheDocument(),
    );
  });
});
