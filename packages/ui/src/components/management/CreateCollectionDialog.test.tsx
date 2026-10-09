// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { renderWithApp } from '../../test-support/render';
import { connectedMockApi } from '../../api/connected-mock';
import { CreateCollectionDialog } from './CreateCollectionDialog';

vi.mock('../../editor/JsonEditor', () => import('../../test-support/json-editor-stub'));

const props = { connectionId: localConnectionId, database: 'shop' };

describe('CreateCollectionDialog', () => {
  it('shows a live error for a name the server would refuse and keeps Create disabled', async () => {
    const api = await connectedMockApi();
    renderWithApp(<CreateCollectionDialog {...props} onClose={vi.fn()} />, { api });

    const name = screen.getByLabelText('Collection name');
    fireEvent.change(name, { target: { value: 'system.users' } });

    expect(
      await screen.findByText('Collection names may not start with system.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create collection' })).toBeDisabled();
  });

  it('asks for a size before a capped collection can be created', async () => {
    const api = await connectedMockApi();
    renderWithApp(<CreateCollectionDialog {...props} onClose={vi.fn()} />, { api });

    fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: 'events' } });
    fireEvent.click(screen.getByLabelText(/Capped collection/));

    expect(screen.getByRole('button', { name: 'Create collection' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Size in bytes'), { target: { value: '1048576' } });
    expect(screen.getByRole('button', { name: 'Create collection' })).toBeEnabled();
  });

  it('creates the collection through the api and closes', async () => {
    const api = await connectedMockApi();
    const onClose = vi.fn();
    const spy = vi.spyOn(api.rpc.management, 'createCollection');
    renderWithApp(<CreateCollectionDialog {...props} onClose={onClose} />, { api });

    fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: 'refunds' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create collection' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith({
      connectionId: localConnectionId,
      database: 'shop',
      name: 'refunds',
      validationLevel: 'strict',
      validationAction: 'error',
    });
    const names = (
      await api.rpc.collections.list({ connectionId: localConnectionId, database: 'shop' })
    ).map((item) => item.name);
    expect(names).toContain('refunds');
  });

  it('shows the server message and stays open when the create fails', async () => {
    const api = await connectedMockApi();
    const onClose = vi.fn();
    renderWithApp(<CreateCollectionDialog {...props} onClose={onClose} />, { api });

    fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: 'orders' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create collection' }));

    expect(await screen.findByText('Collection already exists: shop.orders')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
