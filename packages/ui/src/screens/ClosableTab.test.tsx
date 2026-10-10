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

/** Lists every tab, so a test reads the language and text of the tab the menu acts on. */
function TabProbe() {
  const tabs = useAppStore((state) => state.editors.tabs);
  const order = useAppStore((state) => state.editors.order);
  return (
    <ol>
      {order.map((id) => (
        <li
          key={id}
          data-testid="tab"
          data-language={tabs[id]?.language}
          data-other={tabs[id]?.otherText}
        >
          {tabs[id]?.text}
        </li>
      ))}
    </ol>
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

describe('ClosableTab Open in Mongo entry', () => {
  it('switches the tab to the mongosh and keeps the SQL for the language toggle', async () => {
    const { api } = await openTabMenu('SELECT * FROM orders; DELETE FROM orders', 'sql');
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in Mongo' }));

    await waitFor(() =>
      expect(screen.getByTestId('tab')).toHaveAttribute('data-language', 'mongosh'),
    );
    expect(screen.getAllByTestId('tab')).toHaveLength(1);
    expect(screen.getByTestId('tab').textContent).toBe(
      'db.orders.find({});\ndb.orders.deleteMany({})',
    );
    expect(screen.getByTestId('tab')).toHaveAttribute(
      'data-other',
      'SELECT * FROM orders; DELETE FROM orders',
    );
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('is off, with the reason, when the SQL does not translate', async () => {
    await openTabMenu('SELECT * FROM orders WHERE', 'sql');

    const entry = await screen.findByRole('menuitem', { name: /^Open in Mongo/ });

    expect(entry).toBeDisabled();
    expect(entry).toHaveTextContent('expected an expression but the statement ended');
    expect(screen.getAllByTestId('tab')).toHaveLength(1);
  });

  it('offers no Open in Mongo entry on a mongosh tab', async () => {
    await openTabMenu('db.orders.find()', 'mongosh');

    await screen.findByRole('menuitem', { name: 'Close' });

    expect(screen.queryByRole('menuitem', { name: 'Open in Mongo' })).not.toBeInTheDocument();
  });
});
