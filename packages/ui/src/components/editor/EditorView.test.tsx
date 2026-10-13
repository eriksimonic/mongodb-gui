// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { connectedMockApi } from '../../api/connected-mock';
import type { UiApi } from '../../api/ui-api';
import { renderWithApp } from '../../test-support/render';
import { EDITOR_TAB_ID, editorStateWith } from '../../test-support/editor-state';
import { editorUiEvents, type EditorUiEvent } from '../../editor/editor-events';
import { EditorView } from './EditorView';
import { OutputPanel } from './OutputPanel';

vi.mock('../../editor/MongoshEditor', () => import('../../test-support/mongosh-editor-stub'));
vi.mock('../../kit/code/ReadOnlyCode', () => import('../../test-support/read-only-code-stub'));

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
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
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

    // The Run button turns into Cancel while the statement runs, and back after.
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    fireEvent.click(cancel);

    expect(await screen.findByRole('alert')).toHaveTextContent('The operation was cancelled');
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
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

describe('EditorView SQL mode', () => {
  const SQL_SAMPLES = 'SELECT * FROM bson_samples';
  const MONGOSH_SAMPLES = 'db.bson_samples.find({})';

  async function openSql(text: string, api?: UiApi, database = ANALYTICS) {
    const backend = api ?? (await connectedMockApi());
    const rendered = renderWithApp(
      <>
        <EditorView tabId={EDITOR_TAB_ID} />
        <OutputPanel />
      </>,
      {
        api: backend,
        initialState: {
          editors: editorStateWith(localConnectionId, database, { text, language: 'sql' }),
        },
      },
    );
    return { ...rendered, api: backend };
  }

  /** The marker events the view emitted during the test. */
  let events: EditorUiEvent[] = [];
  let unsubscribe: () => void = () => undefined;

  beforeEach(() => {
    events = [];
    unsubscribe = editorUiEvents.subscribe((event) => {
      if (event.type === 'editor:markers') {
        events.push(event);
      }
    });
  });

  afterEach(() => unsubscribe());

  function preview(): HTMLTextAreaElement {
    return screen.getByRole('textbox', { name: 'Mongo query' }) as HTMLTextAreaElement;
  }

  it('switches a Mongo tab to SQL with the language toggle and saves it as the default', async () => {
    const api = await connectedMockApi();
    await openEditor('db.bson_samples.find()', api);
    expect(screen.getByRole('radio', { name: 'Mongo' })).toBeChecked();
    expect(screen.queryByTestId('sql-preview')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'SQL' }));

    expect(await screen.findByTestId('sql-preview')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'SQL' })).toBeChecked();
    expect(editor().value).toBe('');
    await waitFor(async () => {
      expect((await api.rpc.settings.get()).editorLanguage).toBe('sql');
    });
  });

  it('keeps the toggle on a SQL tab and shows the Mongo text when it switches to Mongo', async () => {
    const api = await connectedMockApi();
    await openSql(SQL_SAMPLES, api);
    expect(screen.getByRole('radio', { name: 'SQL' })).toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: 'Mongo' }));

    expect(await screen.findByRole('radio', { name: 'Mongo' })).toBeChecked();
    expect(screen.queryByTestId('sql-preview')).not.toBeInTheDocument();
    expect(editor().value).toBe('');
  });

  it('brings the SQL back when the toggle returns to SQL, and the Mongo text with it', async () => {
    await openSql(SQL_SAMPLES);
    fireEvent.click(screen.getByRole('radio', { name: 'Mongo' }));
    await screen.findByRole('radio', { name: 'Mongo', checked: true });
    typeText('db.orders.find()');

    fireEvent.click(screen.getByRole('radio', { name: 'SQL' }));
    await waitFor(() => expect(editor().value).toBe(SQL_SAMPLES));
    await waitFor(() => expect(preview().value).toBe(MONGOSH_SAMPLES));
    fireEvent.click(screen.getByRole('radio', { name: 'Mongo' }));

    await waitFor(() => expect(editor().value).toBe('db.orders.find()'));
  });

  it('shows the mongosh of the SQL, read only, beside the editor', async () => {
    await openSql(SQL_SAMPLES);

    await waitFor(() => expect(preview().value).toBe(MONGOSH_SAMPLES));
    expect(preview()).toHaveAttribute('readonly');
    expect(editor().value).toBe(SQL_SAMPLES);
  });

  it('follows the SQL as it is typed', async () => {
    await openSql(SQL_SAMPLES);
    await waitFor(() => expect(preview().value).toBe(MONGOSH_SAMPLES));

    typeText('SELECT TOP 5 * FROM bson_samples');

    await waitFor(() => expect(preview().value).toBe('db.bson_samples.find({}).limit(5)'));
  });

  it('joins the statements of all the SQL in the preview', async () => {
    await openSql(`${SQL_SAMPLES};\nDELETE FROM orders WHERE id = 1`);

    await waitFor(() =>
      expect(preview().value).toBe(`${MONGOSH_SAMPLES};\ndb.orders.deleteMany({ id: 1 })`),
    );
  });

  it('shows the message and no Mongo text when the SQL does not translate', async () => {
    await openSql('SELECT * FROM orders WHERE');

    expect(
      await screen.findByText('expected an expression but the statement ended'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Mongo query' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open in Mongo/ })).toBeDisabled();
  });

  it('says what the preview is for when the SQL is empty', async () => {
    await openSql('');

    expect(screen.getByText('The Mongo query appears here as you type SQL.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open in Mongo/ })).toBeDisabled();
  });

  it('adds no line to the Output panel and runs nothing for the preview', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    await openSql(SQL_SAMPLES, api);

    await waitFor(() => expect(preview().value).toBe(MONGOSH_SAMPLES));

    expect(evaluate).not.toHaveBeenCalled();
    const log = await screen.findByRole('log', { name: 'Output' });
    expect(within(log).queryByText(MONGOSH_SAMPLES)).not.toBeInTheDocument();
  });

  it('switches the tab to the mongosh with Open in Mongo and keeps the SQL for the toggle', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    await openSql(SQL_SAMPLES, api);
    await waitFor(() => expect(preview().value).toBe(MONGOSH_SAMPLES));

    fireEvent.click(screen.getByRole('button', { name: /Open in Mongo/ }));

    expect(await screen.findByRole('radio', { name: 'Mongo', checked: true })).toBeInTheDocument();
    await waitFor(() => expect(editor().value).toBe(MONGOSH_SAMPLES));
    expect(screen.queryByTestId('sql-preview')).not.toBeInTheDocument();
    expect(evaluate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('radio', { name: 'SQL' }));

    await waitFor(() => expect(editor().value).toBe(SQL_SAMPLES));
  });

  it('blocks the toggle on a Mongo tab while a run is in progress', async () => {
    const api = await connectedMockApi();
    vi.spyOn(api.rpc.shell, 'evaluate').mockReturnValue(new Promise(() => undefined));
    await openEditor('db.bson_samples.find()', api);
    pressRun();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'SQL' })).toBeDisabled());

    fireEvent.click(screen.getByRole('radio', { name: 'SQL' }));

    expect(screen.getByRole('radio', { name: 'Mongo' })).toBeChecked();
  });

  it('translates the SQL on Run, prints the mongosh and shows the documents', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    await openSql(SQL_SAMPLES, api);
    pressRun();

    expect(await screen.findByText('1 to 12 of 12')).toBeInTheDocument();
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
      code: MONGOSH_SAMPLES,
      database: ANALYTICS,
    });
    const log = await screen.findByRole('log', { name: 'Output' });
    expect(within(log).getByText(MONGOSH_SAMPLES)).toBeInTheDocument();
  });

  it('records the SQL in history as SQL', async () => {
    const api = await connectedMockApi();
    await openSql(SQL_SAMPLES, api);
    pressRun();
    await screen.findByText('1 to 12 of 12');

    await waitFor(async () => {
      const history = await api.rpc.history.list({
        connectionId: localConnectionId,
        search: 'bson_samples',
      });
      expect(history[0]).toMatchObject({ code: SQL_SAMPLES, language: 'sql' });
    });
  });

  it('uses the sampled field types of the collection in the translation', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    await openSql("SELECT * FROM bson_samples WHERE createdAt > '2026-01-02'", api);
    pressRun();

    await waitFor(() => expect(evaluate).toHaveBeenCalled());
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
      code: "db.bson_samples.find({ createdAt: { $gt: ISODate('2026-01-02T00:00:00.000Z') } })",
    });
  });

  it('runs the SQL statement under the cursor', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    await openSql(`SELECT * FROM orders;\n${SQL_SAMPLES}`, api);
    const position = editor().value.length;
    selectRange(position, position);
    pressRun();

    await waitFor(() => expect(evaluate).toHaveBeenCalled());
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({ code: MONGOSH_SAMPLES });
  });

  it('runs only the selected SQL', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    await openSql(`SELECT * FROM orders;\n${SQL_SAMPLES}`, api);
    const text = editor().value;
    selectRange(text.indexOf(SQL_SAMPLES), text.length);
    pressRun();

    await waitFor(() => expect(evaluate).toHaveBeenCalled());
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({ code: MONGOSH_SAMPLES });
  });

  it('joins every statement for Run all', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    await openSql(`SELECT * FROM orders;\n${SQL_SAMPLES}`, api);
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(evaluate).toHaveBeenCalled());
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
      code: `db.orders.find({});\n${MONGOSH_SAMPLES}`,
    });
  });

  it('marks the tab and underlines the clause when the SQL does not translate', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    await openSql('SELECT * FROM orders WHERE', api);
    pressRun();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'expected an expression but the statement ended',
    );
    expect(events).toEqual([
      {
        type: 'editor:markers',
        tabId: EDITOR_TAB_ID,
        markers: [
          { start: 21, end: 26, message: 'expected an expression but the statement ended' },
        ],
      },
    ]);
    expect(evaluate).not.toHaveBeenCalled();
    const log = await screen.findByRole('log', { name: 'Output' });
    expect(
      within(log).getByText('expected an expression but the statement ended'),
    ).toBeInTheDocument();
  });

  it('places the marker of a later statement at its offset in the text', async () => {
    await openSql('SELECT * FROM orders;\nSELEC * FROM bson_samples');
    const position = editor().value.length;
    selectRange(position, position);
    pressRun();

    await screen.findByRole('alert');
    expect(events[0]).toMatchObject({ markers: [{ start: 22, end: 27 }] });
  });

  it('asks before an UPDATE without WHERE and runs it on confirm', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    await openSql("UPDATE bson_samples SET status = 'x'", api);
    pressRun();

    const dialog = await screen.findByRole('dialog', { name: 'Run a write without WHERE' });
    expect(dialog).toHaveTextContent(
      'This UPDATE has no WHERE and changes every document of bson_samples. Run it?',
    );
    expect(evaluate).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(evaluate).toHaveBeenCalled());
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
      code: "db.bson_samples.updateMany({}, { $set: { status: 'x' } })",
    });
  });

  it('runs nothing when the write without WHERE is cancelled', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    await openSql('DELETE FROM bson_samples', api);
    pressRun();

    const dialog = await screen.findByRole('dialog', { name: 'Run a write without WHERE' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('does not ask before a write with WHERE', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    await openSql("DELETE FROM bson_samples WHERE status = 'x'", api);
    pressRun();

    await waitFor(() => expect(evaluate).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
      code: "db.bson_samples.deleteMany({ status: 'x' })",
    });
  });

  it('explains the translated mongosh', async () => {
    const api = await connectedMockApi();
    const explain = vi.spyOn(api.rpc.explain, 'run');
    await openSql(SQL_SAMPLES, api);
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }));

    await waitFor(() => expect(explain).toHaveBeenCalled());
    expect(explain.mock.calls[0]?.[0]).toMatchObject({
      code: MONGOSH_SAMPLES,
      database: ANALYTICS,
    });
  });

  it('formats the SQL with Format', async () => {
    await openSql("select * from orders where status = 'paid' and total > 5");
    fireEvent.click(screen.getByRole('button', { name: 'Format' }));

    expect(editor().value).toBe("SELECT *\nFROM orders\nWHERE status = 'paid'\n  AND total > 5");
  });

  it('saves a favourite from a SQL tab with the SQL language', async () => {
    const api = await connectedMockApi();
    await openSql(SQL_SAMPLES, api);
    fireEvent.click(screen.getByRole('button', { name: 'Save as favourite' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), {
      target: { value: 'All samples' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const saved = (await api.rpc.favourites.list()).find((item) => item.name === 'All samples');
      expect(saved).toMatchObject({ code: SQL_SAMPLES, language: 'sql' });
    });
  });

  it('does nothing on Run with an empty SQL tab', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    await openSql('   ', api);
    pressRun();
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true, shiftKey: true });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(evaluate).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
