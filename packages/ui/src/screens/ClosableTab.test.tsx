// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { describe, expect, it, vi } from 'vitest';
import { connectedMockApi } from '../api/connected-mock';
import { localConnectionId } from '../api/mock-fixtures';
import { EDITOR_TAB_ID, editorStateWith } from '../test-support/editor-state';
import { renderWithApp } from '../test-support/render';
import { useAppStore } from '../state/app-store-context';
import { ClosableTab } from './ShellPanels';

vi.mock('dockview-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('dockview-react')>()),
  DockviewDefaultTab: () => <span>Editor tab</span>,
}));

/** The header props the tab menu reads: the panel id and a dock without other panels. */
function headerProps(): IDockviewPanelHeaderProps {
  const props = {
    api: { id: EDITOR_TAB_ID },
    containerApi: { getPanel: () => undefined, panels: [], removePanel: vi.fn() },
  };
  return props as unknown as IDockviewPanelHeaderProps;
}

/** Shows the tab the menu converts, so a test reads its language, text and origin. */
function TabProbe() {
  const tab = useAppStore((state) => state.editors.tabs[EDITOR_TAB_ID]);
  return (
    <>
      <span data-testid="language">{tab?.language}</span>
      <span data-testid="text">{tab?.text}</span>
      <span data-testid="origin">{tab?.sqlOrigin?.sql}</span>
    </>
  );
}

async function openTabMenu(text: string, language: 'sql' | 'mongosh') {
  const api = await connectedMockApi();
  const rendered = renderWithApp(
    <>
      <ClosableTab {...headerProps()} />
      <TabProbe />
    </>,
    {
      api,
      initialState: { editors: editorStateWith(localConnectionId, 'shop', { text, language }) },
    },
  );
  fireEvent.contextMenu(screen.getByText('Editor tab'));
  return { ...rendered, api };
}

describe('ClosableTab convert entry', () => {
  it('converts the SQL through the same action as the language toggle', async () => {
    const { api } = await openTabMenu('SELECT * FROM orders; DELETE FROM orders', 'sql');
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Convert to mongosh' }));

    await waitFor(() => expect(screen.getByTestId('language')).toHaveTextContent('mongosh'));
    expect(screen.getByTestId('text').textContent).toBe(
      'db.orders.find({});\ndb.orders.deleteMany({})',
    );
    expect(screen.getByTestId('origin').textContent).toBe(
      'SELECT * FROM orders; DELETE FROM orders',
    );
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('keeps the SQL and the SQL language when the SQL does not translate', async () => {
    await openTabMenu('SELECT * FROM orders WHERE', 'sql');

    const entry = await screen.findByRole('menuitem', { name: /^Convert to mongosh/ });

    expect(entry).toBeDisabled();
    expect(entry).toHaveTextContent('expected an expression but the statement ended');
    expect(screen.getByTestId('language')).toHaveTextContent('sql');
    expect(screen.getByTestId('text').textContent).toBe('SELECT * FROM orders WHERE');
  });

  it('offers no conversion on a mongosh tab', async () => {
    await openTabMenu('db.orders.find()', 'mongosh');

    await screen.findByRole('menuitem', { name: 'Close' });

    expect(screen.queryByRole('menuitem', { name: 'Convert to mongosh' })).not.toBeInTheDocument();
  });
});
