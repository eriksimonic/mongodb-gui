// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectedMockApi } from '../api/connected-mock';
import { localConnectionId } from '../api/mock-fixtures';
import { ManagementDialogs } from '../components/management/ManagementDialogs';
import { ValidationPanel } from '../components/management/ValidationPanel';
import { renderWithApp } from '../test-support/render';
import { SchemaPanel } from './SchemaPanel';
import { MESSY_COLLECTION, MESSY_DATABASE, seedMessyCollection } from './schema-fixtures';

vi.mock('../editor/JsonEditor', () => import('../test-support/json-editor-stub'));

const orders = { connectionId: localConnectionId, database: 'shop', collection: 'orders' };
const messy = {
  connectionId: localConnectionId,
  database: MESSY_DATABASE,
  collection: MESSY_COLLECTION,
};

function bodyRows(): HTMLElement[] {
  return screen.getAllByRole('row').slice(1);
}

function rowFor(path: string): HTMLElement {
  const row = bodyRows().find((item) => within(item).queryByText(path, { selector: 'p' }));
  if (row === undefined) {
    throw new Error(`no row for ${path}`);
  }
  return row;
}

function pathsShown(): string[] {
  return bodyRows().map((row) => row.querySelector('p')?.textContent ?? '');
}

async function analyse(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Analyse' }));
  await screen.findByRole('table', { name: 'Fields' });
}

const clipboard = { writeText: vi.fn<(text: string) => Promise<void>>(() => Promise.resolve()) };

function installClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  clipboard.writeText.mockClear();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SchemaPanel', () => {
  it('asks for an analysis before the first run', async () => {
    const api = await connectedMockApi();
    renderWithApp(<SchemaPanel {...orders} />, { api });

    expect(screen.getByText(/Choose a sample size and strategy/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export report' })).toBeDisabled();
  });

  it('samples the collection and shows the counts, the summary and one row per field', async () => {
    const api = await connectedMockApi();
    const spy = vi.spyOn(api.rpc.schema, 'analyse');
    renderWithApp(<SchemaPanel {...orders} />, { api });

    await analyse();

    expect(spy).toHaveBeenCalledWith({
      ...orders,
      size: 1000,
      strategy: 'random',
    });
    expect(screen.getByText(/Sampled 240 of 240 documents/)).toBeInTheDocument();
    expect(screen.getByText('Fields')).toBeInTheDocument();
    expect(pathsShown()).toEqual(['_id', 'customerId', 'name', 'qty', 'status']);
    const status = rowFor('status');
    expect(within(status).getByRole('img', { name: /Types: String 100%/ })).toBeInTheDocument();
    expect(within(status).getByRole('img', { name: '100% of documents' })).toBeInTheDocument();
  });

  it('notes that the sample is smaller than the collection', async () => {
    const api = await connectedMockApi();
    renderWithApp(<SchemaPanel {...orders} />, { api });

    fireEvent.click(screen.getByRole('textbox', { name: 'Sample size' }));
    fireEvent.click(await screen.findByRole('option', { name: '100 documents' }));
    await analyse();

    expect(screen.getByText(/Sampled 100 of 240 documents/)).toBeInTheDocument();
    expect(screen.getByText(/The sample holds 100 of about 240 documents/)).toBeInTheDocument();
  });

  it('shows a message for an empty collection', async () => {
    const api = await connectedMockApi();
    renderWithApp(<SchemaPanel {...orders} database="shop" collection="paid_orders" />, { api });

    fireEvent.click(screen.getByRole('button', { name: 'Analyse' }));

    expect(
      await screen.findByText('The collection has no documents to sample.'),
    ).toBeInTheDocument();
  });

  it('shows the failure as text and keeps the controls', async () => {
    const api = await connectedMockApi();
    vi.spyOn(api.rpc.schema, 'analyse').mockRejectedValue(new Error('The shell is not running.'));
    renderWithApp(<SchemaPanel {...orders} />, { api });

    fireEvent.click(screen.getByRole('button', { name: 'Analyse' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The shell is not running.');
    expect(screen.getByRole('button', { name: 'Analyse' })).toBeEnabled();
  });

  it('filters rows by path text and by the mixed and sparse flags', async () => {
    const api = await connectedMockApi();
    renderWithApp(<SchemaPanel {...orders} />, { api });
    await analyse();

    fireEvent.change(screen.getByRole('textbox', { name: 'Path contains' }), {
      target: { value: 'CUST' },
    });
    expect(pathsShown()).toEqual(['customerId']);

    fireEvent.change(screen.getByRole('textbox', { name: 'Path contains' }), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only mixed types' }));
    expect(screen.getByText('No fields match the filters.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Only mixed types' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only sparse (under 50%)' }));
    expect(screen.getByText('No fields match the filters.')).toBeInTheDocument();
  });

  it('sorts by path, reversing on the second press', async () => {
    const api = await connectedMockApi();
    renderWithApp(<SchemaPanel {...orders} />, { api });
    await analyse();

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Path' }));
    expect(pathsShown()).toEqual(['_id', 'customerId', 'name', 'qty', 'status']);
    expect(screen.getByRole('columnheader', { name: /Path/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Path' }));
    expect(pathsShown()).toEqual(['status', 'qty', 'name', 'customerId', '_id']);
  });

  it('sorts by the number of types, most first when chosen', async () => {
    const api = await connectedMockApi();
    await seedMessyCollection(api);
    renderWithApp(<SchemaPanel {...messy} />, { api });
    await analyse();

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Types' }));

    // duration holds three types and every other top-level field one, so the ties sort by path.
    expect(pathsShown()).toEqual([
      'duration',
      '_id',
      'at',
      'event',
      'items',
      'note',
      'tags',
      'user',
    ]);
  });

  it('opens nested paths one level at a time', async () => {
    const api = await connectedMockApi();
    await seedMessyCollection(api);
    renderWithApp(<SchemaPanel {...messy} />, { api });
    await analyse();

    expect(pathsShown()).not.toContain('user.plan');
    fireEvent.click(screen.getByRole('button', { name: 'Expand user' }));
    expect(pathsShown()).toEqual(expect.arrayContaining(['user.id', 'user.plan']));

    expect(pathsShown()).not.toContain('items[].sku');
    fireEvent.click(screen.getByRole('button', { name: 'Expand items' }));
    expect(pathsShown()).toContain('items[]');
    expect(pathsShown()).not.toContain('items[].sku');
    fireEvent.click(screen.getByRole('button', { name: 'Expand items[]' }));
    expect(pathsShown()).toContain('items[].sku');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse user' }));
    expect(pathsShown()).not.toContain('user.plan');
  });

  it('shows mixed types and sparse fields with their proportions', async () => {
    const api = await connectedMockApi();
    await seedMessyCollection(api);
    renderWithApp(<SchemaPanel {...messy} />, { api });
    await analyse();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Only mixed types' }));
    // user.plan is null in some documents and a string in the rest.
    expect(pathsShown()).toEqual(['duration', 'user.plan']);
    const duration = rowFor('duration');
    expect(
      within(duration).getByRole('img', { name: 'Types: String 20%; Int32 53%; Double 27%' }),
    ).toBeInTheDocument();
  });

  it('opens the create index dialog with the field in the key builder', async () => {
    const api = await connectedMockApi();
    renderWithApp(
      <>
        <SchemaPanel {...orders} />
        <ManagementDialogs />
      </>,
      { api },
    );
    await analyse();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for status' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Create index on this field' }));

    expect(await screen.findByText('New index on shop.orders')).toBeInTheDocument();
    expect(screen.getByDisplayValue('status')).toBeInTheDocument();
  });

  it('adds a rule for the field to the validation draft', async () => {
    const api = await connectedMockApi();
    renderWithApp(
      <>
        <SchemaPanel {...orders} />
        <ValidationPanel {...orders} />
      </>,
      { api },
    );
    await analyse();
    await screen.findByRole('textbox', { name: 'Validator as EJSON' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for qty' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add to validation rule' }));

    expect(await screen.findByText('Added a rule for qty. Save to keep it.')).toBeInTheDocument();
    const editor = screen.getByRole('textbox', { name: 'Validator as EJSON' });
    expect((editor as HTMLTextAreaElement).value).toContain('"qty": {');
    expect((editor as HTMLTextAreaElement).value).toContain('"bsonType": "int"');
  });

  it('copies the path', async () => {
    installClipboard();
    const api = await connectedMockApi();
    renderWithApp(<SchemaPanel {...orders} />, { api });
    await analyse();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for status' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy path' }));

    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('status'));
  });

  it('copies the query for documents where the field is missing', async () => {
    installClipboard();
    const api = await connectedMockApi();
    await seedMessyCollection(api);
    renderWithApp(<SchemaPanel {...messy} />, { api });
    await analyse();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for note' }));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Find documents where this field is missing' }),
    );

    await waitFor(() =>
      expect(clipboard.writeText).toHaveBeenCalledWith(
        `db.${MESSY_COLLECTION}.find({ "note": { $exists: false } })`,
      ),
    );
  });

  it('copies the report as JSON', async () => {
    installClipboard();
    const api = await connectedMockApi();
    renderWithApp(<SchemaPanel {...orders} />, { api });
    await analyse();

    fireEvent.click(screen.getByRole('button', { name: 'Export report' }));

    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1));
    const [text] = clipboard.writeText.mock.calls[0] ?? [];
    expect(JSON.parse(text ?? '{}')).toMatchObject({
      database: 'shop',
      collection: 'orders',
      sampled: 240,
      total: 240,
    });
  });
});
