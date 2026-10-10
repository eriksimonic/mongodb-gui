// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { connectedMockApi } from '../../api/connected-mock';
import { renderWithApp } from '../../test-support/render';
import { EDITOR_TAB_ID, editorStateWith } from '../../test-support/editor-state';
import { EditorView } from './EditorView';
import { FavouritesPanel } from './FavouritesPanel';
import { HistoryPanel } from './HistoryPanel';
import { OutputPanel } from './OutputPanel';

vi.mock('../../editor/MongoshEditor', () => import('../../test-support/mongosh-editor-stub'));
vi.mock('../../editor/ReadOnlyCode', () => import('../../test-support/read-only-code-stub'));

function editorOf(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: /Query for/ }) as HTMLTextAreaElement;
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
