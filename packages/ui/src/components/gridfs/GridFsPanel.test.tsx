// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { connectedMockApi } from '../../api/connected-mock';
import { renderWithApp } from '../../test-support/render';
import { GridFsPanel } from './GridFsPanel';
import { GridFsBucketDialogs } from './GridFsBucketDialogs';

const RECEIPTS = { connectionId: localConnectionId, database: 'shop', bucket: 'receipts' };
const UPLOAD_WAIT_MS = 4000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GridFsPanel', () => {
  it('lists the files of a bucket with size, chunk size, content type and metadata', async () => {
    const api = await connectedMockApi();
    renderWithApp(<GridFsPanel {...RECEIPTS} />, { api });

    const row = (await screen.findByText('receipt-1001.pdf')).closest<HTMLElement>('[role="row"]');
    expect(row).not.toBeNull();
    if (row === null) {
      return;
    }
    expect(within(row).getByText('82.5 KiB')).toBeInTheDocument();
    expect(within(row).getByText('255.0 KiB')).toBeInTheDocument();
    expect(within(row).getByText('application/pdf')).toBeInTheDocument();
    // The badge counts the top-level metadata fields, and the content type is one of them.
    expect(within(row).getByText('3 fields')).toBeInTheDocument();
    expect(screen.getByText('0 selected')).toBeInTheDocument();
  });

  it('filters the list by a filename fragment', async () => {
    const api = await connectedMockApi();
    renderWithApp(<GridFsPanel {...RECEIPTS} />, { api });
    await screen.findByText('receipt-1001.pdf');

    fireEvent.change(screen.getByRole('textbox', { name: 'Filename contains' }), {
      target: { value: '1003' },
    });

    await waitFor(() => {
      expect(screen.queryByText('receipt-1001.pdf')).not.toBeInTheDocument();
    });
    expect(screen.getByText('receipt-1003.pdf')).toBeInTheDocument();
  });

  it('shows the empty state for a bucket without files', async () => {
    const api = await connectedMockApi();
    renderWithApp(<GridFsPanel {...RECEIPTS} bucket="empty_bucket" />, { api });

    expect(
      await screen.findByText('This bucket has no files yet. Upload a file to start.'),
    ).toBeInTheDocument();
  });

  it('uploads a chosen file with progress and adds it when the job finishes', async () => {
    const api = await connectedMockApi();
    renderWithApp(<GridFsPanel {...RECEIPTS} />, { api });
    await screen.findByText('receipt-1001.pdf');

    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText('Upload orders.csv to shop · receipts')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: /progress/ })).toBeInTheDocument();
    expect(
      await screen.findByText('orders.csv', undefined, { timeout: UPLOAD_WAIT_MS }),
    ).toBeInTheDocument();
  });

  it('cancels a running upload and adds no file', async () => {
    const api = await connectedMockApi();
    renderWithApp(<GridFsPanel {...RECEIPTS} />, { api });
    await screen.findByText('receipt-1001.pdf');

    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(cancel);

    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(screen.queryByText('orders.csv')).not.toBeInTheDocument();
  });

  it('asks before replacing a file in the chosen folder and downloads after the answer', async () => {
    const api = await connectedMockApi();
    renderWithApp(<GridFsPanel {...RECEIPTS} />, { api });
    await screen.findByText('receipt-1001.pdf');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select receipt-1001.pdf' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select receipt-1002.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    const dialog = await screen.findByRole('dialog', { name: 'Replace existing file?' });
    expect(within(dialog).getByText('receipt-1001.pdf')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));

    expect(
      await screen.findByText('Download receipt-1001.pdf from shop · receipts'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Replace existing file?' })).toBeNull();
    });
  });

  it('deletes the selected files after a confirmation that names them', async () => {
    const api = await connectedMockApi();
    const remove = vi.spyOn(api.rpc.gridfs, 'deleteFiles');
    renderWithApp(<GridFsPanel {...RECEIPTS} />, { api });
    await screen.findByText('receipt-1001.pdf');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select receipt-1001.pdf' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select receipt-1004.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete 2 files' });
    expect(within(dialog).getByText('receipt-1004.pdf')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 2 files' }));

    await waitFor(() => {
      expect(screen.queryByText('receipt-1001.pdf')).not.toBeInTheDocument();
    });
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'receipts' }));
    expect(screen.queryByText('receipt-1004.pdf')).not.toBeInTheDocument();
  });

  it('renames the selected file', async () => {
    const api = await connectedMockApi();
    renderWithApp(<GridFsPanel {...RECEIPTS} />, { api });
    await screen.findByText('receipt-1003.pdf');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select receipt-1003.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename receipt-1003.pdf' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'File name' }), {
      target: { value: 'receipt-1003-final.pdf' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));

    expect(await screen.findByText('receipt-1003-final.pdf')).toBeInTheDocument();
    expect(screen.queryByText('receipt-1003.pdf')).not.toBeInTheDocument();
  });

  it('keeps the drop button disabled until the bucket name is typed', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    const drop = vi.spyOn(api.rpc.gridfs, 'dropBucket');
    renderWithApp(<GridFsBucketDialogs />, {
      api,
      initialState: {
        gridfsDialog: {
          kind: 'dropBucket',
          connectionId: localConnectionId,
          database: 'shop',
          bucket: 'product_images',
        },
      },
    });

    const confirm = await screen.findByRole('button', { name: 'Drop bucket' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Type product_images to confirm' }), {
      target: { value: 'product_images' },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(drop).toHaveBeenCalledWith({
        connectionId: localConnectionId,
        database: 'shop',
        bucket: 'product_images',
      });
    });
  });
});
