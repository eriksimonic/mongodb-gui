// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppErrorException, appError } from '@mongo-gui/core';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { renderWithApp } from '../test-support/render';
import { ProfilerPanel } from './ProfilerPanel';
import { profilerUiEvents, type ProfilerUiEvent } from './profiler-events';
import { formatCommand } from './profiler-model';
import type { ProfilerSeed } from './profiler-store';

const SHOP = { connectionId: localConnectionId, database: 'shop' };
const LIMIT = { limit: 200 };

async function connectedApi(level?: 0 | 1 | 2): Promise<UiApi> {
  const api = createMockUiApi({ preset: 'unlocked' });
  await api.rpc.connections.connect({ id: localConnectionId });
  if (level !== undefined) {
    await api.rpc.profiler.setLevel({ ...SHOP, level });
  }
  return api;
}

function renderPanel(api: UiApi, seed?: ProfilerSeed) {
  return renderWithApp(
    <ProfilerPanel connectionId={localConnectionId} database="shop" seed={seed} />,
    { api },
  );
}

/** The slow query table, or the shapes table, whichever is on screen. */
function dataTable(): HTMLElement {
  const table = document.querySelector('table');
  if (table === null) {
    throw new Error('no table on screen');
  }
  return table;
}

/** Body rows of the table on screen, without the header row. */
function bodyRows(): HTMLElement[] {
  return within(dataTable()).getAllByRole('row').slice(1);
}

async function waitForRows(count: number): Promise<void> {
  await waitFor(() => expect(bodyRows()).toHaveLength(count));
}

describe('ProfilerPanel', () => {
  it('lists the operations of the database and only its namespaces', async () => {
    const api = await connectedApi();
    renderPanel(api);
    const expected = await api.rpc.profiler.list({ ...SHOP, filter: LIMIT });
    await waitForRows(expected.length);
    expect(new Set(expected.map((row) => row.ns))).toEqual(
      new Set(['shop.orders', 'shop.customers']),
    );
  });

  it('applies the level and reflects the server value', async () => {
    const api = await connectedApi();
    renderPanel(api);
    fireEvent.click(await screen.findByRole('radio', { name: 'All' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByText('All, 100 ms')).toBeInTheDocument();
    expect((await api.rpc.profiler.level(SHOP)).level).toBe(2);
    expect(screen.queryByLabelText('Slow threshold (ms)')).not.toBeInTheDocument();
  });

  it('shows the threshold and sample rate only for slow only', async () => {
    const api = await connectedApi(1);
    renderPanel(api);
    expect(await screen.findByLabelText('Slow threshold (ms)')).toBeInTheDocument();
    expect(screen.getByLabelText('Sample rate')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    expect(screen.queryByLabelText('Slow threshold (ms)')).not.toBeInTheDocument();
  });

  it('narrows the list with the text search and the Refresh button', async () => {
    const api = await connectedApi();
    renderPanel(api);
    await waitForRows((await api.rpc.profiler.list({ ...SHOP, filter: LIMIT })).length);

    fireEvent.change(screen.getByRole('textbox', { name: 'Text search' }), {
      target: { value: 'customers' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    const expected = await api.rpc.profiler.list({
      ...SHOP,
      filter: { limit: 200, textSearch: 'customers' },
    });
    await waitForRows(expected.length);
    expect(within(dataTable()).queryByText('shop.orders')).not.toBeInTheDocument();
  });

  it('adds rows from the tail and keeps the selected row', async () => {
    const api = await connectedApi();
    renderPanel(api);
    const initial = await api.rpc.profiler.list({ ...SHOP, filter: LIMIT });
    await waitForRows(initial.length);

    fireEvent.click(bodyRows()[1] as HTMLElement);
    const poll = screen.getByRole('textbox', { name: 'Tail poll interval' });
    fireEvent.focus(poll);
    fireEvent.keyDown(poll, { key: 'ArrowDown' });
    // The dropdown is hidden until the combobox transition ends in jsdom, so the option is found hidden.
    fireEvent.click(screen.getByRole('option', { name: '0.5 s', hidden: true }));
    fireEvent.click(screen.getByLabelText('Tail'));

    await waitFor(() => expect(bodyRows().length).toBeGreaterThan(initial.length), {
      timeout: 4000,
    });
    const selected = bodyRows().filter((row) => row.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
  });

  it('shows the level two warning while the tail is on at level 2', async () => {
    const api = await connectedApi(2);
    renderPanel(api);
    await screen.findByText('All, 100 ms');
    expect(screen.queryByText(/At level 2, each tail poll writes/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Tail'));
    expect(await screen.findByText(/At level 2, each tail poll writes/)).toBeInTheDocument();
  });

  it('lists the query shapes and filters the table to a shape on click', async () => {
    const api = await connectedApi();
    renderPanel(api);
    await waitForRows((await api.rpc.profiler.list({ ...SHOP, filter: LIMIT })).length);

    fireEvent.click(screen.getByRole('tab', { name: 'Top shapes' }));
    const shapes = await api.rpc.profiler.shapes({ ...SHOP, filter: LIMIT });
    await waitForRows(shapes.length);

    fireEvent.click(bodyRows()[0] as HTMLElement);
    expect(
      await screen.findByText('Showing the operations of one query shape'),
    ).toBeInTheDocument();
    await waitForRows(shapes[0]?.count ?? -1);
  });

  it('shows the command of the selected operation and fires the detail buttons', async () => {
    const api = await connectedApi();
    renderPanel(api);
    const list = await api.rpc.profiler.list({ ...SHOP, filter: LIMIT });
    await waitForRows(list.length);
    const target = list[0];
    expect(target).toBeDefined();

    fireEvent.click(bodyRows()[0] as HTMLElement);
    const pane = document.querySelector('.mg-profiler-detail') as HTMLElement;
    await waitFor(() =>
      expect(pane.querySelector('pre')?.textContent).toBe(formatCommand(target?.command)),
    );

    const events: ProfilerUiEvent[] = [];
    const unsubscribe = profilerUiEvents.subscribe((event) => events.push(event));
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Explain this' }));
      fireEvent.click(screen.getByRole('button', { name: 'Open in editor' }));
      expect(await screen.findByText('Explain arrives in phase 3.')).toBeInTheDocument();
      expect(events.map((event) => event.type)).toEqual(['profiler:explain', 'profiler:open']);
      expect(events[0]?.ref.entry.id).toBe(target?.id);
    } finally {
      unsubscribe();
    }
  });

  it('shows the error when the server refuses the list', async () => {
    const base = await connectedApi();
    const failing: UiApi = {
      onEvent: base.onEvent,
      rpc: {
        ...base.rpc,
        profiler: {
          ...base.rpc.profiler,
          list: async () => {
            throw new AppErrorException(
              appError('COMMAND_FAILED', 'The server refused the profiler command'),
            );
          },
        },
      },
    };
    renderPanel(failing);
    expect(await screen.findByText('The profiler could not load')).toBeInTheDocument();
    expect(screen.getByText('The server refused the profiler command')).toBeInTheDocument();
  });
});
