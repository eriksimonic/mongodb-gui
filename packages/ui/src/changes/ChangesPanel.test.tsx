// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { renderWithApp } from '../test-support/render';
import { ChangesPanel } from './ChangesPanel';

vi.mock('../editor/JsonEditor', () => import('../test-support/json-editor-stub'));

const PANEL = 'changes:test';
const ORDERS = { kind: 'collection', database: 'shop', collection: 'orders' } as const;
/** Mock events arrive every 500 ms, so waits for them need more than the default second. */
const EVENT_WAIT_MS = 4000;

async function connectedApi(): Promise<UiApi> {
  const api = createMockUiApi({ preset: 'unlocked' });
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

function renderPanel(api: UiApi) {
  return renderWithApp(
    <ChangesPanel panelId={PANEL} connectionId={localConnectionId} target={ORDERS} />,
    { api },
  );
}

/** The rows of the event list, in display order. */
function eventRows(): HTMLElement[] {
  return within(screen.getByRole('listbox', { name: 'Change events' })).getAllByRole('option');
}

async function startWatch(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
  await screen.findByText('Live', undefined, { timeout: EVENT_WAIT_MS });
}

describe('ChangesPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts a watch and lists the events it receives', async () => {
    const api = await connectedApi();
    renderPanel(api);
    await startWatch();

    await waitFor(() => expect(eventRows().length).toBeGreaterThan(0), {
      timeout: EVENT_WAIT_MS,
    });
    expect(screen.getByText(/Received \d+/)).toBeInTheDocument();
    expect(screen.getAllByText('shop.orders').length).toBeGreaterThan(0);
  });

  it('filters the list by operation and shows the empty state when nothing matches', async () => {
    const api = await connectedApi();
    renderPanel(api);
    await startWatch();
    await waitFor(() => expect(eventRows().length).toBeGreaterThanOrEqual(3), {
      timeout: EVENT_WAIT_MS,
    });
    const before = eventRows().length;

    fireEvent.change(screen.getByRole('textbox', { name: 'Filter events' }), {
      target: { value: 'replace' },
    });

    await waitFor(() => {
      const rows = screen.queryAllByRole('option');
      expect(rows.length).toBeLessThan(before);
      for (const row of rows) {
        expect(row).toHaveTextContent('replace');
      }
    });

    fireEvent.change(screen.getByRole('textbox', { name: 'Filter events' }), {
      target: { value: 'no such text' },
    });
    expect(await screen.findByText('No event matches the filter.')).toBeInTheDocument();
  });

  it('selects an event and shows its document and resume token in the detail pane', async () => {
    const api = await connectedApi();
    renderPanel(api);
    await startWatch();
    await waitFor(() => expect(eventRows().length).toBeGreaterThan(0), {
      timeout: EVENT_WAIT_MS,
    });

    const first = eventRows()[0];
    if (first === undefined) {
      throw new Error('no event row');
    }
    fireEvent.click(first);

    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Event document')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume from here' })).toBeEnabled();
    expect(screen.getByText('Cluster time')).toBeInTheDocument();
  });

  it('copies the resume token of the selected event', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const api = await connectedApi();
    renderPanel(api);
    await startWatch();
    await waitFor(() => expect(eventRows().length).toBeGreaterThan(0), {
      timeout: EVENT_WAIT_MS,
    });
    fireEvent.click(eventRows()[0] as HTMLElement);

    fireEvent.click(await screen.findByRole('button', { name: 'Copy token' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeVisible());
    const token = writeText.mock.calls[0]?.[0] ?? '';
    expect(JSON.parse(token)).toHaveProperty('_data');
    expect(screen.getByText(token)).toBeInTheDocument();
  });

  it('stops the watch when the panel closes', async () => {
    const api = await connectedApi();
    const stop = vi.spyOn(api.rpc.changes, 'stop');
    const { unmount } = renderPanel(api);
    await startWatch();

    unmount();

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it('shows the server message when the pipeline is refused', async () => {
    const api = await connectedApi();
    renderPanel(api);
    const pipeline = await screen.findByRole('textbox', { name: 'Change stream pipeline' });
    fireEvent.change(pipeline, { target: { value: '[{"$out": "archive"}]' } });

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(
      await screen.findByText('$out is not allowed in a change stream pipeline'),
    ).toBeInTheDocument();
  });
});
