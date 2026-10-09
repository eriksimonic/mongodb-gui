// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { renderWithApp } from '../../test-support/render';
import { connectedMockApi } from '../../api/connected-mock';
import { IndexesPanel } from './IndexesPanel';

const panel = { connectionId: localConnectionId, database: 'shop', collection: 'orders' };

describe('IndexesPanel', () => {
  it('lists the indexes with their keys, properties and usage', async () => {
    const api = await connectedMockApi();
    renderWithApp(<IndexesPanel {...panel} />, { api });

    const row = (await screen.findByText('status_1_createdAt_-1')).closest('tr');
    expect(row).not.toBeNull();
    if (row === null) {
      return;
    }
    expect(within(row).getByText('status')).toBeInTheDocument();
    expect(within(row).getByText('createdAt')).toBeInTheDocument();
    expect(within(row).getByLabelText('ascending')).toBeInTheDocument();
    expect(within(row).getByLabelText('descending')).toBeInTheDocument();
    expect(within(row).getByText('412 ops since 2026-10-01')).toBeInTheDocument();
    expect(within(row).getByText('36.0 KB')).toBeInTheDocument();
  });

  it('shows the index build in progress from the poll', async () => {
    const api = await connectedMockApi();
    renderWithApp(<IndexesPanel {...panel} />, { api });

    expect(await screen.findByText(/Building customerId_1/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Build of customerId_1' })).toBeInTheDocument();
  });

  it('never offers to drop or hide the _id index', async () => {
    const api = await connectedMockApi();
    renderWithApp(<IndexesPanel {...panel} />, { api });

    const idRow = (await screen.findByText('_id_')).closest('tr');
    expect(idRow).not.toBeNull();
    if (idRow !== null) {
      expect(within(idRow).getByRole('button', { name: 'Drop' })).toBeDisabled();
      expect(within(idRow).getByRole('button', { name: 'Hide' })).toBeDisabled();
    }
  });

  it('hides an index and shows Unhide once the server confirms', async () => {
    const api = await connectedMockApi();
    renderWithApp(<IndexesPanel {...panel} />, { api });

    const row = (await screen.findByText('status_1_createdAt_-1')).closest('tr');
    expect(row).not.toBeNull();
    if (row === null) {
      return;
    }
    fireEvent.click(within(row).getByRole('button', { name: 'Hide' }));

    expect(await within(row).findByRole('button', { name: 'Unhide' })).toBeInTheDocument();
  });

  it('drops an index after the name is typed and removes its row', async () => {
    const api = await connectedMockApi();
    renderWithApp(<IndexesPanel {...panel} />, { api });

    const row = (await screen.findByText('status_1_createdAt_-1')).closest('tr');
    expect(row).not.toBeNull();
    if (row === null) {
      return;
    }
    fireEvent.click(within(row).getByRole('button', { name: 'Drop' }));
    const confirm = screen.getByRole('button', { name: 'Drop index' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type status_1_createdAt_-1 to confirm'), {
      target: { value: 'status_1_createdAt_-1' },
    });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(screen.queryByText('status_1_createdAt_-1')).not.toBeInTheDocument(),
    );
  });

  it('opens the create index dialog from the toolbar', async () => {
    const api = await connectedMockApi();
    renderWithApp(<IndexesPanel {...panel} />, { api });

    fireEvent.click(await screen.findByRole('button', { name: 'Create index' }));
    expect(await screen.findByText('New index on shop.orders')).toBeInTheDocument();
  });
});
