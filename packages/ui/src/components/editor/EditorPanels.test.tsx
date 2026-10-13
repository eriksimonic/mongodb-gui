// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { connectedMockApi } from '../../api/connected-mock';
import type { UiApi } from '../../api/ui-api';
import { renderWithApp } from '../../test-support/render';
import { useAppStore } from '../../state/app-store-context';
import { EDITOR_TAB_ID, editorStateWith } from '../../test-support/editor-state';
import { EditorView } from './EditorView';
import { FavouritesPanel } from './FavouritesPanel';
import { HistoryPanel } from './HistoryPanel';
import { OutputPanel } from './OutputPanel';

vi.mock('../../editor/MongoshEditor', () => import('../../test-support/mongosh-editor-stub'));
vi.mock('../../kit/code/ReadOnlyCode', () => import('../../test-support/read-only-code-stub'));

function editorOf(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: /Query for/ }) as HTMLTextAreaElement;
}

/** Lists the language of each open tab in order, so a test can read what a panel opened. */
function TabLanguages() {
  const order = useAppStore((state) => state.editors.order);
  const tabs = useAppStore((state) => state.editors.tabs);
  return (
    <ul aria-label="Tab languages">
      {order.map((id) => (
        <li key={id}>{tabs[id]?.language}</li>
      ))}
    </ul>
  );
}

/** Records one run of a statement in history, so a panel test has a row to act on. */
async function seedHistory(
  api: UiApi,
  entry: {
    readonly code: string;
    readonly database: string;
    readonly language?: 'sql' | 'mongosh';
  },
): Promise<string> {
  const saved = await api.rpc.history.append({
    connectionId: localConnectionId,
    database: entry.database,
    code: entry.code,
    startedAt: new Date().toISOString(),
    durationMs: 3,
    resultCount: 2,
    ...(entry.language === undefined ? {} : { language: entry.language }),
  });
  return saved.id;
}

function rowOf(id: string): HTMLElement {
  const row = document.querySelector(`[data-entry-id="${id}"]`);
  if (row === null) {
    throw new Error(`no history row for ${id}`);
  }
  return row as HTMLElement;
}

describe('Output panel', () => {
  it('lists the print lines of a run with the database of their editor', async () => {
    const api = await connectedMockApi();
    renderWithApp(
      <>
        <EditorView tabId={EDITOR_TAB_ID} />
        <OutputPanel />
      </>,
      {
        api,
        initialState: {
          editors: editorStateWith(localConnectionId, 'analytics', { text: 'print("hi")' }),
        },
      },
    );
    fireEvent.keyDown(editorOf(), { key: 'Enter', ctrlKey: true });

    const log = await screen.findByRole('log', { name: 'Output' });
    expect(await within(log).findByText('hi')).toBeInTheDocument();
    expect(within(log).getByText('analytics')).toBeInTheDocument();
  });

  it('shows the error of a failed run', async () => {
    const api = await connectedMockApi();
    renderWithApp(
      <>
        <EditorView tabId={EDITOR_TAB_ID} />
        <OutputPanel />
      </>,
      {
        api,
        initialState: {
          editors: editorStateWith(localConnectionId, 'analytics', { text: 'db.a.find(' }),
        },
      },
    );
    fireEvent.keyDown(editorOf(), { key: 'Enter', ctrlKey: true });

    const log = await screen.findByRole('log', { name: 'Output' });
    expect(await within(log).findByText('Unexpected end of input')).toBeInTheDocument();
  });
});

describe('History panel', () => {
  it('lists recorded runs and inserts one into the active editor on click', async () => {
    const api = await connectedMockApi();
    renderWithApp(
      <>
        <EditorView tabId={EDITOR_TAB_ID} />
        <HistoryPanel />
      </>,
      { api, initialState: { editors: editorStateWith(localConnectionId, 'shop', { text: '' }) } },
    );
    const history = await api.rpc.history.list({ connectionId: localConnectionId });
    const entry = history[0];
    expect(entry).toBeDefined();
    const row = await waitFor(() => {
      const found = document.querySelector(`[data-entry-id="${entry?.id ?? ''}"]`);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    const insertButton = row.querySelector('button') as HTMLElement;
    fireEvent.click(insertButton);
    expect(editorOf().value).toContain(entry?.code.split('\n')[0] ?? '');
  });

  it('records a run in history with its database and document count', async () => {
    const api = await connectedMockApi();
    renderWithApp(<EditorView tabId={EDITOR_TAB_ID} />, {
      api,
      initialState: {
        editors: editorStateWith(localConnectionId, 'shop', { text: 'db.orders.find()' }),
      },
    });
    fireEvent.keyDown(editorOf(), { key: 'Enter', ctrlKey: true });

    await waitFor(async () => {
      const rows = await api.rpc.history.list({
        connectionId: localConnectionId,
        search: 'db.orders.find()',
      });
      expect(rows[0]).toMatchObject({ database: 'shop', resultCount: 50 });
    });
  });

  it('re-runs a history entry in an editor on its connection and database', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    renderWithApp(<HistoryPanel />, { api });
    const rows = await api.rpc.history.list({ connectionId: localConnectionId });
    const entry = rows.find((item) => item.code.startsWith('db.'));
    expect(entry).toBeDefined();
    const row = await waitFor(() => {
      const found = document.querySelector(`[data-entry-id="${entry?.id ?? ''}"]`);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    fireEvent.click(within(row).getByRole('button', { name: 'Re-run' }));

    await waitFor(() => expect(evaluate).toHaveBeenCalled());
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
      connectionId: localConnectionId,
      database: entry?.database,
    });
  });
});

describe('Favourites', () => {
  it('saves a statement from the editor, lists it under its folder, and deletes it', async () => {
    const api = await connectedMockApi();
    renderWithApp(
      <>
        <EditorView tabId={EDITOR_TAB_ID} />
        <FavouritesPanel />
      </>,
      {
        api,
        initialState: {
          editors: editorStateWith(localConnectionId, 'shop', {
            text: 'db.orders.find({ status: "paid" })',
          }),
        },
      },
    );

    const before = (await api.rpc.favourites.list()).length;
    fireEvent.click(screen.getByRole('button', { name: 'Save as favourite' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), {
      target: { value: 'Paid orders' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder' }), {
      target: { value: 'Sales' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const item = await waitFor(() => {
      const found = document.querySelector('[data-favourite-id]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(item).getByText('Paid orders')).toBeInTheDocument();
    expect(screen.getByText('Sales')).toBeInTheDocument();

    fireEvent.click(within(item).getByRole('button', { name: 'Delete Paid orders' }));
    await waitFor(async () => {
      expect(await api.rpc.favourites.list()).toHaveLength(before);
    });
  });

  it('asks for a name before saving', async () => {
    const api = await connectedMockApi();
    renderWithApp(<EditorView tabId={EDITOR_TAB_ID} />, {
      api,
      initialState: {
        editors: editorStateWith(localConnectionId, 'shop', { text: 'db.orders.find()' }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save as favourite' }));
    const before = (await api.rpc.favourites.list()).length;
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Give the favourite a name.')).toBeInTheDocument();
    expect(await api.rpc.favourites.list()).toHaveLength(before);
  });
});

describe('Language on history and favourites', () => {
  function favouriteRow(id: string): HTMLElement {
    const row = document.querySelector(`[data-favourite-id="${id}"]`);
    if (row === null) {
      throw new Error(`no favourite row for ${id}`);
    }
    return row as HTMLElement;
  }

  it('marks SQL history entries with a SQL badge and leaves the others unmarked', async () => {
    const api = await connectedMockApi();
    const sqlId = await seedHistory(api, {
      code: 'SELECT * FROM orders;',
      database: 'shop',
      language: 'sql',
    });
    const mongoId = await seedHistory(api, {
      code: 'db.orders.find()',
      database: 'shop',
      language: 'mongosh',
    });
    const legacyId = await seedHistory(api, { code: 'db.legacy.find()', database: 'shop' });
    renderWithApp(<HistoryPanel />, { api });

    await waitFor(() =>
      expect(document.querySelector(`[data-entry-id="${sqlId}"]`)).not.toBeNull(),
    );
    expect(within(rowOf(sqlId)).getByText('SQL')).toBeInTheDocument();
    expect(within(rowOf(mongoId)).queryByText('SQL')).toBeNull();
    expect(within(rowOf(legacyId)).queryByText('SQL')).toBeNull();
  });

  it('re-runs a SQL history entry in a SQL tab and leaves it for the Run button', async () => {
    const api = await connectedMockApi();
    const id = await seedHistory(api, {
      code: 'SELECT * FROM orders;',
      database: 'shop',
      language: 'sql',
    });
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    renderWithApp(
      <>
        <HistoryPanel />
        <TabLanguages />
      </>,
      { api },
    );

    fireEvent.click(within(await waitFor(() => rowOf(id))).getByRole('button', { name: 'Re-run' }));

    const list = screen.getByRole('list', { name: 'Tab languages' });
    await waitFor(() => expect(within(list).getByText('sql')).toBeInTheDocument());
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('re-runs a mongosh history entry in a mongosh tab', async () => {
    const api = await connectedMockApi();
    const id = await seedHistory(api, { code: 'db.orders.countDocuments()', database: 'shop' });
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    renderWithApp(
      <>
        <HistoryPanel />
        <TabLanguages />
      </>,
      { api },
    );

    fireEvent.click(within(await waitFor(() => rowOf(id))).getByRole('button', { name: 'Re-run' }));

    await waitFor(() => expect(evaluate).toHaveBeenCalled());
    const list = screen.getByRole('list', { name: 'Tab languages' });
    expect(within(list).getByText('mongosh')).toBeInTheDocument();
  });

  it('inserts a SQL history entry into a tab of its own beside an open mongosh tab', async () => {
    const api = await connectedMockApi();
    const id = await seedHistory(api, { code: 'SELECT 1;', database: 'shop', language: 'sql' });
    renderWithApp(
      <>
        <EditorView tabId={EDITOR_TAB_ID} />
        <HistoryPanel />
        <TabLanguages />
      </>,
      {
        api,
        initialState: { editors: editorStateWith(localConnectionId, 'shop', { text: '' }) },
      },
    );

    const row = await waitFor(() => rowOf(id));
    fireEvent.click(row.querySelector('button') as HTMLElement);

    const list = screen.getByRole('list', { name: 'Tab languages' });
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['mongosh', 'sql']),
    );
    expect(editorOf().value).toBe('');
  });

  it('saves a SQL history entry as a favourite with its language', async () => {
    const api = await connectedMockApi();
    const id = await seedHistory(api, {
      code: 'SELECT * FROM orders;',
      database: 'shop',
      language: 'sql',
    });
    renderWithApp(<HistoryPanel />, { api });

    fireEvent.click(
      within(await waitFor(() => rowOf(id))).getByRole('button', { name: 'Save as favourite' }),
    );
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), {
      target: { value: 'SQL orders' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const saved = (await api.rpc.favourites.list()).find((item) => item.name === 'SQL orders');
      expect(saved).toMatchObject({ language: 'sql', code: 'SELECT * FROM orders;' });
    });
  });

  it('marks SQL favourites with a SQL badge and leaves the others unmarked', async () => {
    const api = await connectedMockApi();
    const sql = await api.rpc.favourites.save({
      name: 'Orders in SQL',
      code: 'SELECT * FROM orders;',
      connectionId: localConnectionId,
      database: 'shop',
      language: 'sql',
    });
    const mongo = await api.rpc.favourites.save({
      name: 'Orders in mongosh',
      code: 'db.orders.find()',
      connectionId: localConnectionId,
      database: 'shop',
    });
    renderWithApp(<FavouritesPanel />, { api });

    const sqlRow = await waitFor(() => favouriteRow(sql.id));
    expect(within(sqlRow).getByText('SQL')).toBeInTheDocument();
    expect(within(favouriteRow(mongo.id)).queryByText('SQL')).toBeNull();
  });

  it('inserts an SQL favourite into a SQL tab when no tab is open', async () => {
    const api = await connectedMockApi();
    const sql = await api.rpc.favourites.save({
      name: 'Top orders',
      code: 'SELECT TOP 5 * FROM orders;',
      connectionId: localConnectionId,
      database: 'shop',
      language: 'sql',
    });
    renderWithApp(
      <>
        <FavouritesPanel />
        <TabLanguages />
      </>,
      { api },
    );

    const row = await waitFor(() => favouriteRow(sql.id));
    fireEvent.click(within(row).getByTitle('Insert into the active editor'));

    const list = screen.getByRole('list', { name: 'Tab languages' });
    await waitFor(() => expect(within(list).getByText('sql')).toBeInTheDocument());
  });

  it('re-runs an SQL favourite in a SQL tab without running it', async () => {
    const api = await connectedMockApi();
    const sql = await api.rpc.favourites.save({
      name: 'Top orders',
      code: 'SELECT TOP 5 * FROM orders;',
      connectionId: localConnectionId,
      database: 'shop',
      language: 'sql',
    });
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    renderWithApp(
      <>
        <FavouritesPanel />
        <TabLanguages />
      </>,
      { api },
    );

    const row = await waitFor(() => favouriteRow(sql.id));
    fireEvent.click(within(row).getByRole('button', { name: 'Re-run Top orders' }));

    const list = screen.getByRole('list', { name: 'Tab languages' });
    await waitFor(() => expect(within(list).getByText('sql')).toBeInTheDocument());
    expect(evaluate).not.toHaveBeenCalled();
  });
});
