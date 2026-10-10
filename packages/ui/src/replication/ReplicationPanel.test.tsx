// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppErrorException, appError } from '@mongo-gui/core';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { renderWithApp } from '../test-support/render';
import { ReplicationPanel } from './ReplicationPanel';

async function replicaSetApi(): Promise<UiApi> {
  const api = createMockUiApi({ preset: 'unlocked', replication: true });
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

function renderPanel(api: UiApi) {
  return renderWithApp(<ReplicationPanel connectionId={localConnectionId} />, { api });
}

/** The table row of one member, found by its host. */
function memberRow(host: string): HTMLElement {
  const row = screen.getAllByRole('row').find((item) => item.textContent?.includes(host));
  if (row === undefined) {
    throw new Error(`no row for ${host}`);
  }
  return row;
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog');
}

async function waitForMembers(count: number): Promise<void> {
  await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(count + 1));
}

describe('ReplicationPanel', () => {
  it('shows the set header and one row per member with its state and lag', async () => {
    const api = await replicaSetApi();
    renderPanel(api);

    expect(await screen.findByText('Replica set rs0')).toBeInTheDocument();
    expect(screen.getByText('Primary: localhost:27017')).toBeInTheDocument();
    expect(screen.getByText('Config version 4, term 2')).toBeInTheDocument();
    await waitForMembers(3);

    expect(memberRow('localhost:27017').querySelector('[data-meaning]')).toHaveAttribute(
      'data-meaning',
      'primary',
    );
    expect(memberRow('localhost:27018').querySelector('[data-meaning]')).toHaveAttribute(
      'data-meaning',
      'secondary',
    );
    expect(memberRow('localhost:27019').querySelector('[data-meaning]')).toHaveAttribute(
      'data-meaning',
      'arbiter',
    );
    expect(within(memberRow('localhost:27018')).getByText('2.5 s')).toBeInTheDocument();
  });

  it('refreshes the reads when Refresh is pressed', async () => {
    const api = await replicaSetApi();
    const spy = vi.spyOn(api.rpc.replication, 'getStatus');
    renderPanel(api);
    await waitForMembers(3);
    const before = spy.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(before));
  });

  it('steps the primary down after the dialog confirms the seconds', async () => {
    const api = await replicaSetApi();
    const spy = vi.spyOn(api.rpc.replication, 'stepDown');
    renderPanel(api);
    await waitForMembers(3);

    fireEvent.click(screen.getByRole('button', { name: 'Step down' }));
    expect(within(dialog()).getByText(/will not seek election again/)).toBeInTheDocument();
    fireEvent.change(within(dialog()).getByLabelText('Seconds'), { target: { value: '30' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Step down' }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ connectionId: localConnectionId, stepDownSeconds: 30 }),
    );
    await waitFor(() => expect(screen.getByText('Primary: localhost:27018')).toBeInTheDocument());
  });

  it('shows a refused add as a red reason and keeps Apply disabled', async () => {
    const api = await replicaSetApi();
    const applySpy = vi.spyOn(api.rpc.replication, 'applyReconfig');
    renderPanel(api);
    await waitForMembers(3);

    fireEvent.click(screen.getByRole('button', { name: 'Add member' }));
    fireEvent.change(within(dialog()).getByLabelText('Host'), {
      target: { value: 'localhost:27018' },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Preview change' }));

    const refusal = await within(dialog()).findByText('This change is refused');
    expect(refusal.closest('[role="alert"]')).toHaveTextContent(/already a member/);
    fireEvent.change(within(dialog()).getByLabelText('Type rs0 to confirm'), {
      target: { value: 'rs0' },
    });
    expect(within(dialog()).getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('edits a member after a dry run and applies it once the set name is typed', async () => {
    const api = await replicaSetApi();
    const applySpy = vi.spyOn(api.rpc.replication, 'applyReconfig');
    renderPanel(api);
    await waitForMembers(3);

    fireEvent.click(within(memberRow('localhost:27018')).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(dialog()).getByLabelText('Priority'), { target: { value: '3' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Preview change' }));

    const dryRun = await within(dialog()).findByLabelText('Dry run');
    expect(
      within(dryRun).getByText(/Set priority of localhost:27018 from 1 to 3/),
    ).toBeInTheDocument();
    const apply = within(dialog()).getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();

    fireEvent.change(within(dialog()).getByLabelText('Type rs0 to confirm'), {
      target: { value: 'rs0' },
    });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);

    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(within(memberRow('localhost:27018')).getAllByText('3')[0]).toBeInTheDocument(),
    );
    expect(screen.getByText('Config version 5, term 2')).toBeInTheDocument();
  });

  it('removes the arbiter only after the set name is typed', async () => {
    const api = await replicaSetApi();
    const applySpy = vi.spyOn(api.rpc.replication, 'applyReconfig');
    renderPanel(api);
    await waitForMembers(3);

    fireEvent.click(within(memberRow('localhost:27019')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Preview change' }));
    await within(dialog()).findByLabelText('Dry run');

    const apply = within(dialog()).getByRole('button', { name: 'Apply' });
    const typed = within(dialog()).getByLabelText('Type rs0 to confirm');
    expect(apply).toBeDisabled();
    fireEvent.change(typed, { target: { value: 'rs' } });
    expect(apply).toBeDisabled();
    fireEvent.change(typed, { target: { value: 'rs0' } });
    fireEvent.click(apply);

    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    await waitForMembers(2);
    expect(screen.queryByText('localhost:27019')).not.toBeInTheDocument();
  });

  it('offers an initiate on a node started with --replSet and no configuration', async () => {
    const api = createMockUiApi({ preset: 'unlocked', replSetUninitiated: true });
    await api.rpc.connections.connect({ id: localConnectionId });
    renderPanel(api);

    expect(await screen.findByText('No replica set yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Initiate' }));
    fireEvent.change(within(dialog()).getByLabelText('Set name'), { target: { value: 'rs1' } });
    fireEvent.change(within(dialog()).getByLabelText('Type rs1 to confirm'), {
      target: { value: 'rs1' },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Initiate' }));

    expect(await screen.findByText('Replica set rs1')).toBeInTheDocument();
  });

  it('disables the actions that change the set after a failed refresh', async () => {
    const api = await replicaSetApi();
    renderPanel(api);
    await waitForMembers(3);
    expect(screen.getByRole('button', { name: 'Step down' })).toBeEnabled();

    vi.spyOn(api.rpc.replication, 'getStatus').mockRejectedValueOnce(
      new AppErrorException(appError('CONNECTION_FAILED', 'Could not connect to the server')),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('Could not connect to the server')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Step down' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add member' })).toBeDisabled();
    expect(
      within(memberRow('localhost:27018')).getByRole('button', { name: 'Edit' }),
    ).toBeDisabled();
    expect(
      within(memberRow('localhost:27018')).getByRole('button', { name: 'Remove' }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Step down' })).toBeEnabled());
  });

  it('keeps the step-down minimum at 11 seconds', async () => {
    const api = await replicaSetApi();
    renderPanel(api);
    await waitForMembers(3);

    fireEvent.click(screen.getByRole('button', { name: 'Step down' }));
    const seconds = within(dialog()).getByLabelText('Seconds');
    const confirm = within(dialog()).getByRole('button', { name: 'Step down' });
    fireEvent.change(seconds, { target: { value: '10' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(seconds, { target: { value: '11' } });
    expect(confirm).toBeEnabled();
  });

  it('starts the initiate host from the node and sends the host the user edits', async () => {
    const api = createMockUiApi({ preset: 'unlocked', replSetUninitiated: true });
    await api.rpc.connections.connect({ id: localConnectionId });
    const spy = vi.spyOn(api.rpc.replication, 'initiate');
    renderPanel(api);

    await screen.findByText('No replica set yet');
    fireEvent.click(screen.getByRole('button', { name: 'Initiate' }));
    const host = within(dialog()).getByLabelText('Host');
    await waitFor(() => expect(host).toHaveValue('localhost:27017'));

    fireEvent.change(host, { target: { value: 'db4.example.net:27017' } });
    fireEvent.change(within(dialog()).getByLabelText('Type rs0 to confirm'), {
      target: { value: 'rs0' },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Initiate' }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({
        connectionId: localConnectionId,
        setName: 'rs0',
        members: [{ host: 'db4.example.net:27017' }],
      }),
    );
  });

  it('refuses an initiate host that is not host:port', async () => {
    const api = createMockUiApi({ preset: 'unlocked', replSetUninitiated: true });
    await api.rpc.connections.connect({ id: localConnectionId });
    renderPanel(api);

    await screen.findByText('No replica set yet');
    fireEvent.click(screen.getByRole('button', { name: 'Initiate' }));
    const host = within(dialog()).getByLabelText('Host');
    await waitFor(() => expect(host).toHaveValue('localhost:27017'));
    fireEvent.change(host, { target: { value: 'user:pw@db4:27017' } });
    fireEvent.change(within(dialog()).getByLabelText('Type rs0 to confirm'), {
      target: { value: 'rs0' },
    });
    expect(within(dialog()).getByRole('button', { name: 'Initiate' })).toBeDisabled();
  });
});
