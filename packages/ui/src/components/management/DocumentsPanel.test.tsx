// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { renderWithApp } from '../../test-support/render';
import { connectedMockApi } from '../../api/connected-mock';
import { DocumentsPanel } from './DocumentsPanel';

vi.mock('../../editor/JsonEditor', () => import('../../test-support/json-editor-stub'));

const panel = { connectionId: localConnectionId, database: 'shop', collection: 'orders' };
const FIRST_ID = '{"$oid":"000000000000000000000001"}';

function bodyRows(): HTMLElement[] {
  return screen.getAllByRole('row').slice(1);
}

describe('DocumentsPanel', () => {
  it('shows the first 20 documents with _id and the top-level fields', async () => {
    const api = await connectedMockApi();
    renderWithApp(<DocumentsPanel {...panel} />, { api });

    expect(await screen.findByText('Showing 20 of the first 20 documents')).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(20);
    expect(screen.getByRole('columnheader', { name: 'customerId' })).toBeInTheDocument();
    expect(within(bodyRows()[0] as HTMLElement).getByText(FIRST_ID)).toBeInTheDocument();
  });

  it('loads up to 200 documents when Load more is pressed', async () => {
    const api = await connectedMockApi();
    renderWithApp(<DocumentsPanel {...panel} />, { api });

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Showing 200 of the first 200 documents')).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(200);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('edits a document and replaces it with the same _id', async () => {
    const api = await connectedMockApi();
    const spy = vi.spyOn(api.rpc.management, 'replaceDocument');
    renderWithApp(<DocumentsPanel {...panel} />, { api });

    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'Edit document' }))[0] as HTMLElement,
    );
    const editor = await screen.findByLabelText('Document as EJSON');
    expect((editor as HTMLTextAreaElement).value).toContain('"name": "orders-1"');

    fireEvent.change(editor, {
      target: { value: '{"_id":{"$oid":"000000000000000000000001"},"qty":9' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Not valid JSON/)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();

    // The orders validator requires status, customerId and qty, so the replacement keeps them.
    const replacement =
      '{"_id":{"$oid":"000000000000000000000001"},"name":"orders-1","status":"pending","customerId":"C-1","qty":9}';
    fireEvent.change(editor, { target: { value: replacement } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(screen.queryByLabelText('Document as EJSON')).not.toBeInTheDocument(),
    );
    expect(spy).toHaveBeenCalledWith({
      connectionId: localConnectionId,
      database: 'shop',
      collection: 'orders',
      idEjson: FIRST_ID,
      documentEjson: replacement,
    });
  });

  it('inserts a copy without the _id when a document is duplicated', async () => {
    const api = await connectedMockApi();
    const spy = vi.spyOn(api.rpc.management, 'insertDocument');
    renderWithApp(<DocumentsPanel {...panel} />, { api });

    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'Duplicate document' }))[0] as HTMLElement,
    );
    const editor = (await screen.findByLabelText('Document as EJSON')) as HTMLTextAreaElement;
    expect(editor.value).not.toContain('_id');
    fireEvent.click(screen.getByRole('button', { name: 'Insert copy' }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ collection: 'orders' });
  });

  it('deletes one document after confirmation', async () => {
    const api = await connectedMockApi();
    const spy = vi.spyOn(api.rpc.management, 'deleteDocuments');
    renderWithApp(<DocumentsPanel {...panel} />, { api });

    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'Delete document' }))[0] as HTMLElement,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ idsEjson: [FIRST_ID] })),
    );
    // The panel reloads with the same limit, so the 21st document takes the deleted one's place.
    await waitFor(() => expect(screen.queryByText(FIRST_ID)).not.toBeInTheDocument());
    expect(bodyRows()).toHaveLength(20);
  });

  it('deletes the shown documents and names their count in the confirmation', async () => {
    const api = await connectedMockApi();
    const spy = vi.spyOn(api.rpc.management, 'deleteDocuments');
    renderWithApp(<DocumentsPanel {...panel} />, { api });

    await screen.findByText('Showing 20 of the first 20 documents');
    fireEvent.click(screen.getByRole('button', { name: 'Delete all shown' }));
    expect(screen.getByText(/Delete the 20 documents shown/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete 20 documents' }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ idsEjson: expect.arrayContaining([FIRST_ID]) });
    expect(((spy.mock.calls[0]?.[0] as { idsEjson: string[] }).idsEjson ?? []).length).toBe(20);
  });

  it('enables delete by filter only after the server count and deletes that count', async () => {
    const api = await connectedMockApi();
    const spy = vi.spyOn(api.rpc.management, 'deleteByFilter');
    renderWithApp(<DocumentsPanel {...panel} />, { api });

    await screen.findByText('Showing 20 of the first 20 documents');
    fireEvent.change(screen.getByLabelText('Filter'), {
      target: { value: '{"status":"pending"}' },
    });
    const deleteMatching = screen.getByRole('button', { name: 'Delete matching' });
    expect(deleteMatching).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Count matches' }));
    const enabled = await screen.findByRole('button', { name: 'Delete 80 matching' });
    expect(enabled).toBeEnabled();
    fireEvent.click(enabled);
    fireEvent.click(screen.getByRole('button', { name: 'Delete 80 documents' }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ filterEjson: '{"status":"pending"}', expectedCount: 80 }),
      ),
    );
  });
});
