// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { renderWithApp } from '../../test-support/render';
import { ShardCollectionDialog } from './ShardCollectionDialog';

const NAMESPACE = 'shop.sensor_readings';

async function clusterApi() {
  const api = createMockUiApi({ preset: 'unlocked', sharding: 'cluster' });
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

function renderDialog(api: ReturnType<typeof createMockUiApi>, onClose = vi.fn()) {
  renderWithApp(
    <ShardCollectionDialog
      connectionId={localConnectionId}
      database="shop"
      collection="sensor_readings"
      onClose={onClose}
    />,
    { api },
  );
  return onClose;
}

function fieldInput(): HTMLElement {
  return screen.getByRole('textbox', { name: 'Field 1' });
}

describe('ShardCollectionDialog', () => {
  it('keeps Apply disabled until the key is previewed and the namespace typed', async () => {
    const api = await clusterApi();
    const apply = vi.spyOn(api.rpc.sharding, 'shardCollection');
    renderDialog(api);

    fireEvent.change(fieldInput(), { target: { value: 'deviceId' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const preview = await screen.findByLabelText('Preview');
    expect(within(preview).getByText('{ deviceId: 1 }')).toBeInTheDocument();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ confirmed: false }));

    const applyButton = screen.getByRole('button', { name: 'Apply' });
    expect(applyButton).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: `Type ${NAMESPACE} to confirm` }), {
      target: { value: NAMESPACE },
    });
    expect(applyButton).toBeEnabled();
  });

  it('drops the preview when the key changes', async () => {
    const api = await clusterApi();
    renderDialog(api);

    fireEvent.change(fieldInput(), { target: { value: 'deviceId' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByLabelText('Preview');
    fireEvent.change(screen.getByRole('textbox', { name: `Type ${NAMESPACE} to confirm` }), {
      target: { value: NAMESPACE },
    });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();

    fireEvent.change(fieldInput(), { target: { value: 'sensorId' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.queryByLabelText('Preview')).not.toBeInTheDocument();
  });

  it('applies the confirmed call and closes', async () => {
    const api = await clusterApi();
    const apply = vi.spyOn(api.rpc.sharding, 'shardCollection');
    const onClose = renderDialog(api);

    fireEvent.change(fieldInput(), { target: { value: 'deviceId' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByLabelText('Preview');
    fireEvent.change(screen.getByRole('textbox', { name: `Type ${NAMESPACE} to confirm` }), {
      target: { value: NAMESPACE },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(apply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        database: 'shop',
        collection: 'sensor_readings',
        keyEjson: '{"deviceId":1}',
        confirmed: true,
      }),
    );
  });

  it('shows the server refusal in a red alert and keeps the dialog open', async () => {
    const api = await clusterApi();
    const onClose = vi.fn();
    renderWithApp(
      <ShardCollectionDialog
        connectionId={localConnectionId}
        database="shop"
        collection="orders"
        onClose={onClose}
      />,
      { api },
    );

    fireEvent.change(fieldInput(), { target: { value: 'region' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByLabelText('Preview');
    fireEvent.change(screen.getByRole('textbox', { name: 'Type shop.orders to confirm' }), {
      target: { value: 'shop.orders' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByText(/The collection is already sharded/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
