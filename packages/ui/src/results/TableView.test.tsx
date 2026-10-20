// @vitest-environment jsdom
import '../test-support/browser-shims';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { bsonSampleDocuments } from '../api/mock-bson-fixtures';
import { AppProviders } from '../theme/AppProviders';
import { compareCells } from './cell-order';
import { TableView } from './TableView';
import { discoverColumns, type JsonObject } from './result-model';

const DOCUMENTS = bsonSampleDocuments(3) as JsonObject[];

function renderTable(
  onOpenDocument = vi.fn(),
  editable = true,
  documents: JsonObject[] = DOCUMENTS,
  readFull: (ref: string) => Promise<string> = () => Promise.reject(new Error('no read')),
  onSetField: (edit: {
    documentIndex: number;
    path: string;
    value: unknown;
  }) => Promise<void> = () => Promise.resolve(),
) {
  return render(
    <AppProviders>
      <div style={{ height: 400, width: 1000 }} className="mg-virtual-scroll">
        <TableView
          documents={documents}
          columns={discoverColumns(documents)}
          editable={editable}
          editabilityNote="Only a plain find can be edited."
          onOpenDocument={onOpenDocument}
          onSetField={onSetField}
          readFull={readFull}
          onSelectionChange={() => undefined}
        />
      </div>
    </AppProviders>,
  );
}

/** Starts editing the cell with F2. jsdom does not give the grid the native double-click it waits for. */
function startEditing(content: HTMLElement): void {
  const cell = content.closest<HTMLElement>('[role="gridcell"]');
  if (cell === null) {
    throw new Error('The content is not inside a grid cell');
  }
  fireEvent.mouseDown(cell);
  fireEvent.click(cell);
  fireEvent.keyDown(cell, { key: 'F2' });
}

/** The cell that shows the second customer's name. */
async function customerCell(): Promise<HTMLElement> {
  return (await screen.findAllByText('Customer 2'))[0] as HTMLElement;
}

describe('TableView', () => {
  it('shows a column per discovered field path with its BSON type badges', async () => {
    renderTable();

    expect((await screen.findAllByText('customer.address.city')).length).toBeGreaterThan(0);
  });

  it('renders each BSON type with its own cell style', async () => {
    renderTable();

    await waitFor(() =>
      expect(document.querySelector('[data-bson-type="ObjectId"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-bson-type="ObjectId"]')).toHaveAttribute(
      'title',
      DOCUMENTS[0] ? (DOCUMENTS[0]._id as { $oid: string }).$oid : '',
    );
    expect(document.querySelector('[data-bson-type="Date"]')?.textContent).toBe(
      '2026-01-15T08:30:00.000Z',
    );
    expect(document.querySelector('[data-bson-type="Int32"]')?.textContent).toBe('1');
    expect(document.querySelector('[data-bson-type="Int64"]')).not.toBeNull();
    expect(document.querySelector('[data-bson-type="Boolean"]')?.textContent).toBe('true');
  });

  it('offers copy value, key and document on a right-clicked cell', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderTable();
    const cell = (await screen.findAllByText('Customer 2'))[0] as HTMLElement;

    fireEvent.contextMenu(cell, { clientX: 40, clientY: 50 });

    expect(await screen.findByText('Copy value')).toBeInTheDocument();
    expect(screen.getByText('Copy key')).toBeInTheDocument();
    expect(screen.getByText('Copy document')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Copy key'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('customer.name'));
  });

  it('opens the document for editing from the right-click menu', async () => {
    const onOpen = vi.fn();
    renderTable(onOpen);
    const index = DOCUMENTS.findIndex(
      (document) => (document.customer as { name: string }).name === 'Customer 2',
    );
    const cell = (await screen.findAllByText('Customer 2'))[0] as HTMLElement;

    fireEvent.contextMenu(cell, { clientX: 40, clientY: 50 });
    fireEvent.click(await screen.findByText('Edit document'));

    expect(onOpen).toHaveBeenCalledWith(index);
  });

  it('copies the value in mongosh form and the whole document as JSON', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderTable();
    const cell = (await screen.findAllByText('Customer 2'))[0] as HTMLElement;
    const doc = DOCUMENTS.find(
      (document) => (document.customer as { name: string }).name === 'Customer 2',
    );

    fireEvent.contextMenu(cell, { clientX: 40, clientY: 50 });
    fireEvent.click(await screen.findByText('Copy value'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Customer 2'));

    fireEvent.contextMenu(cell, { clientX: 40, clientY: 50 });
    fireEvent.click(await screen.findByText('Copy document'));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(JSON.stringify([doc], null, 2)));
  });

  it('opens the double-clicked document when the result is read only', async () => {
    const onOpen = vi.fn();
    renderTable(onOpen, false);
    const index = DOCUMENTS.findIndex(
      (document) => (document.customer as { name: string }).name === 'Customer 2',
    );

    fireEvent.doubleClick(await customerCell());

    // The grid reports double-clicks on a timer, so the check waits for the call.
    expect(index).toBeGreaterThanOrEqual(0);
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(index));
    expect(screen.getByText('Read only')).toBeInTheDocument();
  });

  it('edits a scalar cell in place and writes the typed value', async () => {
    const onOpen = vi.fn();
    const onSetField = vi.fn().mockResolvedValue(undefined);
    renderTable(onOpen, true, DOCUMENTS, undefined, onSetField);
    const index = DOCUMENTS.findIndex(
      (document) => (document.customer as { name: string }).name === 'Customer 2',
    );

    startEditing(await customerCell());
    const input = await screen.findByRole('textbox', { name: 'Edit customer.name' });
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(onSetField).toHaveBeenCalledWith({
        documentIndex: index,
        path: 'customer.name',
        value: 'Renamed',
      }),
    );
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('keeps the editor open with the reason when the text does not fit the type', async () => {
    const onSetField = vi.fn().mockResolvedValue(undefined);
    renderTable(vi.fn(), true, [{ _id: 1, qty: { $numberInt: '3' } }], undefined, onSetField);

    startEditing(await screen.findByText('3'));
    const input = await screen.findByRole('textbox', { name: 'Edit qty' });
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText(/Enter a whole number/)).toBeInTheDocument();
    expect(onSetField).not.toHaveBeenCalled();
  });

  it('cancels with Escape without writing', async () => {
    const onSetField = vi.fn().mockResolvedValue(undefined);
    renderTable(vi.fn(), true, DOCUMENTS, undefined, onSetField);

    startEditing(await customerCell());
    const input = await screen.findByRole('textbox', { name: 'Edit customer.name' });
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(onSetField).not.toHaveBeenCalled();
  });

  it('opens the document when the double-clicked cell is the _id', async () => {
    const onOpen = vi.fn();
    renderTable(onOpen, true);
    const id = (DOCUMENTS[0]?._id as { $oid: string }).$oid;

    fireEvent.doubleClick(await screen.findByText(id));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(0));
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('TableView shortened values', () => {
  const REF = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222';
  const PREVIEW: JsonObject = {
    _id: 1,
    name: 'Previewed',
    big: { $mgTruncated: { t: 'array', n: 200000 } },
    $mgTruncated: { ref: REF, chars: 3_600_000 },
  };
  const FULL = { _id: 1, name: 'Previewed', big: [1, 2, 3] };

  it('shows a marker as a size summary and no column for the root marker', async () => {
    renderTable(vi.fn(), true, [PREVIEW]);

    expect(await screen.findByText('[…] 200000 items')).toBeInTheDocument();
    expect(screen.queryByText('$mgTruncated')).toBeNull();
  });

  it('copies the full value of a marker from the full document', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const readFull = vi.fn().mockResolvedValue(JSON.stringify(FULL));
    renderTable(vi.fn(), true, [PREVIEW], readFull);
    const cell = await screen.findByText('[…] 200000 items');

    fireEvent.contextMenu(cell, { clientX: 40, clientY: 50 });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Copy value/ }));

    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(JSON.stringify(FULL.big, null, 2)),
    );
    expect(readFull).toHaveBeenCalledWith(REF);
  });

  it('shows the full value of a marker in a modal', async () => {
    const readFull = vi.fn().mockResolvedValue(JSON.stringify(FULL));
    renderTable(vi.fn(), true, [PREVIEW], readFull);
    const cell = await screen.findByText('[…] 200000 items');

    fireEvent.contextMenu(cell, { clientX: 40, clientY: 50 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'View value' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(readFull).toHaveBeenCalledWith(REF);
  });

  it('copies the full document of a preview', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const readFull = vi.fn().mockResolvedValue(JSON.stringify(FULL));
    renderTable(vi.fn(), true, [PREVIEW], readFull);
    const cell = await screen.findByText('[…] 200000 items');

    fireEvent.contextMenu(cell, { clientX: 40, clientY: 50 });
    fireEvent.click(await screen.findByText('Copy document'));

    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(JSON.stringify([FULL], null, 2)),
    );
    expect(readFull).toHaveBeenCalledWith(REF);
  });
});

describe('compareCells', () => {
  it('orders numbers by value, not by text', () => {
    expect(compareCells({ $numberInt: '10' }, { $numberInt: '9' })).toBeGreaterThan(0);
  });

  it('orders other values by their shown text', () => {
    expect(compareCells('apple', 'banana')).toBeLessThan(0);
    expect(compareCells(null, 'x')).toBeLessThan(0);
  });
});
