// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectedMockApi } from '../api/connected-mock';
import { renderWithApp } from '../test-support/render';
import type { ResultSet } from '../state/editors';
import { OPEN_MAX_CHARS } from './full-documents';
import type { JsonObject } from './result-model';
import { ResultsPane, type ResultsPaneProps } from './ResultsPane';

vi.mock('../editor/JsonEditor', () => import('../test-support/json-editor-stub'));
vi.mock('../editor/ReadOnlyCode', () => import('../test-support/read-only-code-stub'));

const REF = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222';
const TARGET = { connectionId: 'c', database: 'shop', collection: 'orders' };
const FULL = { _id: 7, name: 'Full', big: [1, 2, 3] };

function previewDoc(chars: number): JsonObject {
  return {
    _id: 6,
    name: 'Preview',
    big: { $mgTruncated: { t: 'array', n: 200000 } },
    $mgTruncated: { ref: REF, chars },
  };
}

function resultOf(documents: JsonObject[], chars = 100): ResultSet {
  return {
    requestId: 'r',
    statement: 'db.orders.find()',
    database: 'shop',
    type: 'Cursor',
    documents,
    hasMore: false,
    cursorRequestId: undefined,
    printableEjson: undefined,
    summary: undefined,
    elapsedMs: 1,
    collection: 'orders',
    loadingMore: false,
    chars,
    capped: false,
  };
}

async function renderPane(props: Partial<ResultsPaneProps> & { readonly result: ResultSet }) {
  const api = await connectedMockApi();
  return renderWithApp(
    <div style={{ height: 500, width: 1000 }}>
      <ResultsPane
        target={TARGET}
        onDocumentSaved={() => undefined}
        error={undefined}
        running={undefined}
        view="tree"
        onView={() => undefined}
        onLoadMore={() => undefined}
        onLoadAll={() => undefined}
        readFull={() => Promise.reject(new Error('no read'))}
        onSetField={() => Promise.resolve()}
        onUnsetField={() => Promise.resolve()}
        onExport={() => undefined}
        {...props}
      />
    </div>,
    { api },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ResultsPane previews', () => {
  it('opens a previewed row from the full document and saves by its _id', async () => {
    const readFull = vi.fn().mockResolvedValue(JSON.stringify(FULL));
    const { api } = await renderPane({ result: resultOf([previewDoc(3_600_000)]), readFull });
    const replace = vi
      .spyOn(api.rpc.management, 'replaceDocument')
      .mockResolvedValue(undefined as never);

    fireEvent.doubleClick(screen.getByRole('treeitem', { name: '#1' }));

    const editor = (await screen.findByLabelText('Document as EJSON')) as HTMLTextAreaElement;
    expect(readFull).toHaveBeenCalledWith(REF);
    expect(JSON.parse(editor.value)).toEqual(FULL);
    expect(editor.value).not.toContain('$mgTruncated');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(replace.mock.calls[0]?.[0]).toMatchObject({ idEjson: '7' });
  });

  it('shows a notice for a document too large to open and opens no dialog', async () => {
    const readFull = vi.fn();
    await renderPane({ result: resultOf([previewDoc(OPEN_MAX_CHARS * 2)]), readFull });

    fireEvent.doubleClick(screen.getByRole('treeitem', { name: '#1' }));

    expect(await screen.findByText(/This document is 8\.0 MB/)).toBeInTheDocument();
    expect(readFull).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Document as EJSON')).toBeNull();
  });

  it('shows the read error and opens no dialog when the full document is gone', async () => {
    const readFull = vi.fn().mockRejectedValue(new Error('The document is no longer stored.'));
    await renderPane({ result: resultOf([previewDoc(5000)]), readFull });

    fireEvent.doubleClick(screen.getByRole('treeitem', { name: '#1' }));

    expect(await screen.findByText('The document is no longer stored.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Document as EJSON')).toBeNull();
  });

  it('opens a result that cannot be edited read-only from the full text', async () => {
    const readFull = vi.fn().mockResolvedValue(JSON.stringify(FULL));
    await renderPane({ target: undefined, result: resultOf([previewDoc(5000)]), readFull });

    fireEvent.doubleClick(screen.getByRole('treeitem', { name: '#1' }));

    const shown = (await screen.findByLabelText('Document as JSON')) as HTMLTextAreaElement;
    expect(shown.value).toContain('Full');
    expect(shown.value).not.toContain('mgTruncated');
  });

  it('copies the full documents of previews as JSON', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const readFull = vi.fn().mockResolvedValue(JSON.stringify(FULL));
    await renderPane({ result: resultOf([previewDoc(5000)], 3000), readFull });

    fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(JSON.parse(writeText.mock.calls[0]?.[0] as string)).toEqual([FULL]);
  });

  it('refuses a copy over 8 MiB with an error and leaves the clipboard alone', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const readFull = vi.fn();
    await renderPane({ result: resultOf([previewDoc(9 * 1024 * 1024)]), readFull });

    fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }));

    expect(await screen.findByText('Too large to copy. Use Export.')).toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
    expect(readFull).not.toHaveBeenCalled();
  });

  it('copies a large result of whole documents, which has no size to refuse', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const documents: JsonObject[] = Array.from({ length: 5 }, (_, n) => ({
      n,
      pad: 'x'.repeat(10),
    }));
    await renderPane({ result: resultOf(documents, 10 * 1024 * 1024) });

    fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  });

  it('windows the JSON view of a large result and says which values are shortened', async () => {
    const documents: JsonObject[] = Array.from({ length: 5000 }, (_, n) => ({ n }));
    documents[0] = previewDoc(5000);
    await renderPane({ view: 'json', result: resultOf(documents, 5000 * 1000) });

    expect(
      await screen.findByText(/Showing the first 2,097 of 5,000 documents/),
    ).toBeInTheDocument();
    expect(screen.getByText('Some values are shortened.')).toBeInTheDocument();
  });

  it('shows the whole result in the JSON view when it fits the window', async () => {
    await renderPane({ view: 'json', result: resultOf([{ n: 1 }], 20) });

    await screen.findByLabelText('Result as JSON');
    expect(screen.queryByText(/Showing the first/)).toBeNull();
    expect(screen.queryByText('Some values are shortened.')).toBeNull();
  });

  it('says the cursor has more once the memory limit is reached', async () => {
    const result: ResultSet = {
      ...resultOf([{ n: 1 }]),
      hasMore: true,
      cursorRequestId: 'c',
      capped: true,
    };
    await renderPane({ result });

    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.getByTestId('result-capped')).toHaveTextContent(
      'The query has more documents than the 1 shown, and Export writes only those.',
    );
  });

  it('says nothing about a limit when the capped result has no more documents', async () => {
    await renderPane({ result: { ...resultOf([{ n: 1 }]), capped: true } });

    expect(screen.queryByTestId('result-capped')).toBeNull();
  });

  it('counts the previews with no stored copy and says what that costs', async () => {
    const unkept = { ...previewDoc(5000), $mgTruncated: { chars: 5000 } };
    await renderPane({
      result: { ...resultOf([unkept, unkept, previewDoc(5000)]), capped: true, hasMore: true },
    });

    expect(screen.getByTestId('result-unkept')).toHaveTextContent(
      '2 documents were too large to keep in full, so they show a preview only.',
    );
    expect(screen.queryByTestId('result-capped')).toBeNull();
  });
});
