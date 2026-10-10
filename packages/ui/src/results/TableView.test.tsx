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

  it('does not open a document when the result is read only', async () => {
    const onOpen = vi.fn();
    renderTable(onOpen, false);

    fireEvent.doubleClick((await screen.findAllByText('Customer 2'))[0] as HTMLElement);

    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByText('Read only')).toBeInTheDocument();
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
