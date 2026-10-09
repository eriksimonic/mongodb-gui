// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { connectedMockApi } from '../../api/connected-mock';
import type { UiApi } from '../../api/ui-api';
import { renderWithApp } from '../../test-support/render';
import { EDITOR_TAB_ID, editorStateWith } from '../../test-support/editor-state';
import { EditorView } from './EditorView';

vi.mock('../../editor/MongoshEditor', () => import('../../test-support/mongosh-editor-stub'));
vi.mock('../../editor/ReadOnlyCode', () => import('../../test-support/read-only-code-stub'));

const ANALYTICS = 'analytics';

async function openEditor(text: string, api?: UiApi, database = ANALYTICS) {
  const backend = api ?? (await connectedMockApi());
  const rendered = renderWithApp(<EditorView tabId={EDITOR_TAB_ID} />, {
    api: backend,
    initialState: { editors: editorStateWith(localConnectionId, database, { text }) },
  });
  return { ...rendered, api: backend };
}

function editor(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: /Query for/ }) as HTMLTextAreaElement;
}

function typeText(text: string) {
  fireEvent.change(editor(), { target: { value: text } });
}

function selectRange(start: number, end: number) {
  editor().setSelectionRange(start, end);
}

function pressRun() {
  fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true });
}

describe('EditorView run', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the statement under the cursor on Ctrl+Enter and shows the documents', async () => {
    const text = 'db.bson_samples.find()';
    await openEditor(text);
    selectRange(5, 5);
    pressRun();

    expect(await screen.findByText('1 to 12 of 12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDisabled();
  });

  it('runs only the selection when one is made', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    await openEditor('db.orders.find()\n\ndb.bson_samples.countDocuments()', api);
    const text = editor().value;
    const start = text.indexOf('db.bson_samples');
    selectRange(start, text.length);
    pressRun();

    await waitFor(() => expect(evaluate).toHaveBeenCalled());
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({ code: 'db.bson_samples.countDocuments()' });
  });

  it('sends the whole text for Run all on Ctrl+Shift+Enter', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    await openEditor('db.bson_samples.find()', api);
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(evaluate).toHaveBeenCalled());
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
      code: 'db.bson_samples.find()',
      database: ANALYTICS,
    });
  });

  it('shows the error of a statement that does not parse', async () => {
    await openEditor('db.bson_samples.find(');
    pressRun();

    expect(await screen.findByRole('alert')).toHaveTextContent('Unexpected end of input');
  });

  it('cancels a running statement and shows that it was cancelled', async () => {
    await openEditor('sleep(5000)');
    pressRun();

    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(cancel);

    expect(await screen.findByRole('alert')).toHaveTextContent('The operation was cancelled');
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('pages the cursor with Load more and counts what is loaded', async () => {
    await openEditor('db.orders.find()', undefined, 'shop');
    pressRun();

    expect(await screen.findByText('1 to 50 of ?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('1 to 100 of ?')).toBeInTheDocument();
  });

  it('shows a non-cursor value as JSON with its summary', async () => {
    await openEditor('db.bson_samples.countDocuments()');
    pressRun();

    const view = await screen.findByRole('textbox', { name: 'Result as JSON' });
    expect(view).toHaveValue('12');
    expect(screen.getByRole('radio', { name: 'JSON' })).toBeChecked();
  });

  it('formats the text with Format', async () => {
    await openEditor('db.orders.find({status:"paid"})');
    fireEvent.click(screen.getByRole('button', { name: 'Format' }));

    expect(editor().value).toBe('db.orders.find({\n  status: "paid"\n})\n');
  });

  it('marks the tab unsaved until the text is saved as a favourite', async () => {
    await openEditor('db.orders.find()');
    expect(screen.queryByLabelText('Unsaved changes')).not.toBeInTheDocument();
    typeText('db.orders.find({})');
    expect(screen.getByLabelText('Unsaved changes')).toBeInTheDocument();
  });
});

describe('EditorView results', () => {
  it('switches between the table, tree and JSON views', async () => {
    await openEditor('db.bson_samples.find()');
    pressRun();
    await screen.findByText('1 to 12 of 12');

    fireEvent.click(screen.getByRole('radio', { name: 'Tree' }));
    expect(await screen.findByRole('tree', { name: 'Document tree' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'JSON' }));
    const json = await screen.findByRole('textbox', { name: 'Result as JSON' });
    expect((json as HTMLTextAreaElement).value).toContain('ORD-00001');
  });

  it('lists the discovered columns in the column chooser', async () => {
    await openEditor('db.bson_samples.find()');
    pressRun();
    await screen.findByText('1 to 12 of 12');

    fireEvent.click(screen.getByRole('button', { name: /^Columns / }));
    expect(await screen.findByRole('checkbox', { name: 'customer.address.geo.lat' })).toBeChecked();
    expect(screen.getByLabelText('_id', { selector: 'input' })).toBeChecked();
    fireEvent.click(screen.getByLabelText('_id', { selector: 'input' }));
    expect(screen.getByLabelText('_id', { selector: 'input' })).not.toBeChecked();
  });

  it('expands a document in the tree and copies a field path', async () => {
    await openEditor('db.bson_samples.find()', await connectedMockApi());
    pressRun();
    await screen.findByText('1 to 12 of 12');
    fireEvent.click(screen.getByRole('radio', { name: 'Tree' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Expand #1' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy path status' }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('status');
  });

  it('edits a leaf in the tree and writes it with updateDocumentFields', async () => {
    const api = await connectedMockApi();
    const update = vi.spyOn(api.rpc.management, 'updateDocumentFields');
    await openEditor('db.bson_samples.find()', api);
    pressRun();
    await screen.findByText('1 to 12 of 12');
    fireEvent.click(screen.getByRole('radio', { name: 'Tree' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Expand #1' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit status' }));
    const input = screen.getByRole('textbox', { name: 'New value for status' });
    fireEvent.change(input, { target: { value: 'shipped' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      connectionId: localConnectionId,
      database: ANALYTICS,
      collection: 'bson_samples',
      idEjson: '{"$oid":"000000000000000000000001"}',
      setEjson: '{"status":"shipped"}',
    });
    expect(await screen.findByText('shipped')).toBeInTheDocument();
  });

  it('refuses an edit with a value that does not fit the type picked', async () => {
    const api = await connectedMockApi();
    const update = vi.spyOn(api.rpc.management, 'updateDocumentFields');
    await openEditor('db.bson_samples.find()', api);
    pressRun();
    await screen.findByText('1 to 12 of 12');
    fireEvent.click(screen.getByRole('radio', { name: 'Tree' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Expand #1' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit quantity' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New value for quantity' }), {
      target: { value: 'many' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save value' }));

    expect(
      await screen.findByText('Enter a whole number between -2147483648 and 2147483647.'),
    ).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps tree editing off for a result that is not a plain find', async () => {
    await openEditor('db.bson_samples.find().map((d) => d)');
    pressRun();
    await screen.findByText('1 to 12 of 12');
    fireEvent.click(screen.getByRole('radio', { name: 'Tree' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Expand #1' }));
    expect(screen.queryByRole('button', { name: 'Edit status' })).not.toBeInTheDocument();
    expect(screen.getByText('Read only')).toBeInTheDocument();
  });
});
