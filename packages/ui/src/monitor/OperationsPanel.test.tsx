// @vitest-environment jsdom
import { AppErrorException, appError } from '@mongo-gui/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { renderWithApp } from '../test-support/render';
import { OperationsPanel } from './OperationsPanel';

/** A mock api with the local connection open, so the operations calls succeed. */
async function connectedApi(): Promise<UiApi> {
  const api = createMockUiApi({ preset: 'unlocked' });
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

function dataRows(): HTMLElement[] {
  return screen.queryAllByRole('row').slice(1);
}

describe('OperationsPanel', () => {
  it('lists the active operations and hides idle connections and system threads', async () => {
    renderWithApp(<OperationsPanel connectionId={localConnectionId} />, {
      api: await connectedApi(),
    });

    expect(await screen.findByRole('button', { name: 'Kill operation 1077' })).toBeInTheDocument();
    expect(dataRows()).toHaveLength(3);
    expect(screen.queryByText('reporting')).not.toBeInTheDocument();
    expect(screen.queryByText('JournalFlusher')).not.toBeInTheDocument();
  });

  it('shows idle connections when the switch is on, with kill disabled for them', async () => {
    renderWithApp(<OperationsPanel connectionId={localConnectionId} />, {
      api: await connectedApi(),
    });
    await screen.findByRole('button', { name: 'Kill operation 1077' });

    fireEvent.click(screen.getByLabelText('Include idle connections'));

    expect(await screen.findByText('reporting')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kill operation conn:88' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Kill operation 1077' })).toBeEnabled();
  });

  it('filters rows by namespace', async () => {
    renderWithApp(<OperationsPanel connectionId={localConnectionId} />, {
      api: await connectedApi(),
    });
    await screen.findByRole('button', { name: 'Kill operation 1077' });

    fireEvent.change(screen.getByLabelText('Search by namespace'), {
      target: { value: 'EVENTS' },
    });

    expect(dataRows()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Kill operation 1077' })).toBeInTheDocument();
  });

  it('asks for confirmation, kills the operation and removes its row', async () => {
    const api = await connectedApi();
    const killOperation = vi.spyOn(api.rpc.monitor, 'killOperation');
    renderWithApp(<OperationsPanel connectionId={localConnectionId} />, { api });
    await screen.findByRole('button', { name: 'Kill operation 1077' });

    fireEvent.click(screen.getByRole('button', { name: 'Kill operation 1077' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Kill operation 1077 on shop.events?')).toBeInTheDocument();
    expect(within(dialog).getByText(/aggregate/)).toBeInTheDocument();
    expect(killOperation).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Kill' }));

    await waitFor(() =>
      expect(killOperation).toHaveBeenCalledWith({
        connectionId: localConnectionId,
        opid: 1077,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Kill operation 1077' })).not.toBeInTheDocument(),
    );
  });

  it('shows the api error when the list cannot load', async () => {
    const api = await connectedApi();
    vi.spyOn(api.rpc.monitor, 'operations').mockRejectedValue(
      new AppErrorException(appError('NOT_CONNECTED', 'Connect to the server first')),
    );
    renderWithApp(<OperationsPanel connectionId={localConnectionId} />, { api });

    expect(await screen.findByText('Connect to the server first')).toBeInTheDocument();
  });

  it('does not poll while the panel is hidden', async () => {
    const api = await connectedApi();
    const operations = vi.spyOn(api.rpc.monitor, 'operations');
    renderWithApp(<OperationsPanel connectionId={localConnectionId} visible={false} />, { api });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(operations).not.toHaveBeenCalled();
  });
});
