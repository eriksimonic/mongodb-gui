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

function renderTable(onOpenDocument = vi.fn(), editable = true) {
  return render(
    <AppProviders>
      <div style={{ height: 400, width: 1000 }} className="mg-virtual-scroll">
        <TableView
          documents={DOCUMENTS}
          columns={discoverColumns(DOCUMENTS)}
          editable={editable}
          editabilityNote="Only a plain find can be edited."
          onOpenDocument={onOpenDocument}
          onSelectionChange={() => undefined}
        />
      </div>
    </AppProviders>,
  );
}

/** The grid row that shows the second customer. */
async function customerRow(): Promise<HTMLElement> {
  const cell = (await screen.findAllByText('Customer 2'))[0] as HTMLElement;
  const row = cell.closest<HTMLElement>('[role="row"]');
  if (row === null) {
    throw new Error('The customer cell is not inside a grid row');
  }
  return row;
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

    fireEvent.doubleClick(await customerRow());

    // The grid reports row double-clicks on a timer, so the check waits for the call.
    expect(index).toBeGreaterThanOrEqual(0);
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(index));
    expect(screen.getByText('Read only')).toBeInTheDocument();
  });

  it('opens the double-clicked document when the result can be edited', async () => {
    const onOpen = vi.fn();
    renderTable(onOpen, true);

    fireEvent.doubleClick(await customerRow());

    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
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
