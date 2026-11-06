// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectedMockApi } from '../api/connected-mock';
import { localConnectionId } from '../api/mock-fixtures';
import { renderWithApp } from '../test-support/render';
import { CopyDialogs } from './CopyDialogs';
import { useCopyDialogs } from './copy-dialog-store';

afterEach(() => {
  useCopyDialogs.setState({ request: undefined, jobId: undefined });
});

describe('CopyDialogs', () => {
  it('lists the collections of a database and leaves out its views', async () => {
    const api = await connectedMockApi();
    renderWithApp(<CopyDialogs />, { api });

    act(() => {
      useCopyDialogs.getState().open({
        variant: 'database',
        connectionId: localConnectionId,
        database: 'shop',
      });
    });

    expect(await screen.findByRole('dialog', { name: 'Copy database shop' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'orders' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'customers' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'paid_orders' })).not.toBeInTheDocument();
  });

  it('says a database without collections has nothing to copy and keeps start disabled', async () => {
    const api = await connectedMockApi();
    vi.spyOn(api.rpc.collections, 'list').mockResolvedValue([]);
    renderWithApp(<CopyDialogs />, { api });

    act(() => {
      useCopyDialogs.getState().open({
        variant: 'database',
        connectionId: localConnectionId,
        database: 'empty_db',
      });
    });

    expect(
      await screen.findByText('This database has no collections to copy.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start copy' })).toBeDisabled();
  });

  it('opens the dialog for one collection', async () => {
    const api = await connectedMockApi();
    renderWithApp(<CopyDialogs />, { api });

    act(() => {
      useCopyDialogs.getState().open({
        variant: 'one',
        connectionId: localConnectionId,
        database: 'shop',
        collection: 'customers',
      });
    });

    expect(await screen.findByRole('dialog', { name: 'Copy collection' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Source collection' })).toHaveValue('customers');
  });

  it('cancels the job from the progress view', async () => {
    const api = await connectedMockApi();
    const cancel = vi.spyOn(api.rpc.copy, 'cancel').mockResolvedValue(undefined);
    renderWithApp(<CopyDialogs />, { api });

    act(() => {
      useCopyDialogs.getState().showJob('job-1');
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ jobId: 'job-1' }));
  });

  it('hides the progress view with no close control while it has no result', async () => {
    const api = await connectedMockApi();
    renderWithApp(<CopyDialogs />, { api });

    act(() => {
      useCopyDialogs.getState().showJob('job-1');
    });

    expect(await screen.findByRole('dialog', { name: 'Copy progress' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();

    act(() => {
      useCopyDialogs.getState().closeJob();
    });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Copy progress' })).not.toBeInTheDocument(),
    );
  });
});
