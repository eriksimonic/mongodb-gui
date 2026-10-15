// @vitest-environment jsdom
import '../test-support/browser-shims';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppErrorException, appError, groupByShape, type ProfileEntry } from '@mongo-gui/core';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { renderWithApp } from '../test-support/render';
import { ProfilerPanel } from './ProfilerPanel';
import { profilerUiEvents, type ProfilerUiEvent } from './profiler-events';
import {
  explainTarget,
  formatCommandJson,
  formatDuration,
  formatLocalTime,
  isProblematic,
  userCommand,
} from './profiler-model';
import type { ProfilerSeed } from './profiler-store';
import { profilerScenarios } from './mock-scenarios';

vi.mock('../kit/code/JsonEditor', () => import('../test-support/json-editor-stub'));

const SHOP = { connectionId: localConnectionId, database: 'shop' };
const LIMIT = { limit: 200 };
const TOTAL = profilerScenarios.length;
const BAD_TOKENS = ['NaN', 'Infinity', 'undefined', '[object Object]'] as const;
const CELL = { time: 0, ns: 1, op: 2, duration: 3, examined: 4, returned: 5, ratio: 6, plan: 7 };

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

/** The slow query grid, which is virtualised. Only rows near the viewport are in the DOM. */
function slowGrid(): HTMLElement {
  const grid = document.querySelector('.mg-profiler-scroll');
  if (grid === null) {
    throw new Error('no slow query grid on screen');
  }
  return grid as HTMLElement;
}

/** The shapes table, which is a plain table. */
function dataTable(): HTMLElement {
  const table = document.querySelector('table');
  if (table === null) {
    throw new Error('no table on screen');
  }
  return table;
}

/** Rendered body rows of the slow query grid, in display order. */
function bodyRows(): HTMLElement[] {
  return Array.from(slowGrid().querySelectorAll<HTMLElement>('[data-row-index]')).sort(
    (a, b) => Number(a.dataset['rowIndex']) - Number(b.dataset['rowIndex']),
  );
}

async function waitForRows(count: number): Promise<void> {
  await waitFor(() => expect(bodyRows()).toHaveLength(count));
}

async function renderScenarios(): Promise<UiApi> {
  const api = createMockUiApi({ preset: 'unlocked', profilerEntries: profilerScenarios });
  await api.rpc.connections.connect({ id: localConnectionId });
  renderWithApp(<ProfilerPanel connectionId={localConnectionId} database="shop" />, { api });
  await waitForRows(TOTAL);
  return api;
}

// The editable command in the detail pane, or undefined when the entry has none.
function commandText(): string | undefined {
  return detailPane().querySelector<HTMLTextAreaElement>('textarea[aria-label="Command"]')?.value;
}

function cellsOf(row: HTMLElement): HTMLElement[] {
  return Array.from(row.querySelectorAll<HTMLElement>('[role="gridcell"]'));
}

/** The row of an entry, found by its local time, which is unique across the scenarios. */
function rowFor(entry: ProfileEntry): HTMLElement {
  const time = formatLocalTime(entry.ts);
  const row = bodyRows().find((candidate) => cellsOf(candidate)[CELL.time]?.textContent === time);
  if (row === undefined) {
    throw new Error(`no row for ${entry.id}`);
  }
  return row;
}

function expectedRatio(entry: ProfileEntry): string {
  // No ratio without both counts, or when nothing was returned. The Examined column carries the count.
  if (entry.docsExamined === undefined || entry.nreturned === undefined || entry.nreturned === 0) {
    return '-';
  }
  return (entry.docsExamined / entry.nreturned).toFixed(1);
}

function expectNoBadTokens(): void {
  const text = document.body.textContent ?? '';
  for (const token of BAD_TOKENS) {
    expect(text).not.toContain(token);
  }
}

function clickRow(entry: ProfileEntry): HTMLElement {
  const row = rowFor(entry);
  fireEvent.click(row);
  return row;
}

function detailPane(): HTMLElement {
  const pane = document.querySelector('.mg-profiler-detail');
  if (pane === null) {
    throw new Error('no detail pane on screen');
  }
  return pane as HTMLElement;
}

/** The value next to a metric label in the detail pane. */
function metricOf(label: string): string | null | undefined {
  return within(detailPane()).getByText(label).nextElementSibling?.textContent;
}

function badgeTexts(element: HTMLElement): string[] {
  return Array.from(element.querySelectorAll('.mantine-Badge-root')).map((badge) =>
    (badge.textContent ?? '').trim(),
  );
}

function bodyText(): string {
  return document.body.textContent ?? '';
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
    expect(within(slowGrid()).queryByText('shop.orders')).not.toBeInTheDocument();
  });

  it('hides rows that are not problematic while "Only problematic" is on', async () => {
    const api = await connectedApi();
    renderPanel(api);
    const list = await api.rpc.profiler.list({ ...SHOP, filter: LIMIT });
    await waitForRows(list.length);
    const problematic = list.filter(isProblematic);
    expect(problematic.length).toBeGreaterThan(0);
    expect(problematic.length).toBeLessThan(list.length);

    fireEvent.click(screen.getByLabelText('Only problematic'));
    await waitForRows(problematic.length);
    expect(within(slowGrid()).queryByText('IXSCAN { email: 1 }')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Only problematic'));
    await waitForRows(list.length);
  });

  it('keeps the selected row inside the client height after scrollToIndex', async () => {
    const api = await connectedApi();
    renderPanel(api);
    const list = await api.rpc.profiler.list({ ...SHOP, filter: LIMIT });
    await waitForRows(list.length);

    fireEvent.click(bodyRows()[0] as HTMLElement);
    fireEvent.keyDown(slowGrid(), { key: 'End' });
    await waitFor(() => expect(bodyRows().at(-1)?.getAttribute('aria-selected')).toBe('true'));

    // Row offsets in the body start below the header. The header is the first row of the grid.
    const row = bodyRows().at(-1) as HTMLElement;
    const translate = /translateY\((-?[\d.]+)px\)/.exec(row.style.transform);
    expect(translate).not.toBeNull();
    const headerPx = 32;
    const rowTop = headerPx + Number(translate?.[1]);
    const grid = slowGrid();
    const visibleTop = grid.scrollTop;
    const visibleBottom = grid.scrollTop + grid.clientHeight;
    expect(rowTop).toBeGreaterThanOrEqual(visibleTop + headerPx);
    expect(rowTop + 32).toBeLessThanOrEqual(visibleBottom);
  });

  it('moves the selection with the arrow keys from the grid', async () => {
    const api = await connectedApi();
    renderPanel(api);
    await waitForRows((await api.rpc.profiler.list({ ...SHOP, filter: LIMIT })).length);

    fireEvent.click(bodyRows()[0] as HTMLElement);
    fireEvent.keyDown(slowGrid(), { key: 'ArrowDown' });
    fireEvent.keyDown(slowGrid(), { key: 'ArrowDown' });
    await waitFor(() => expect(bodyRows()[2]?.getAttribute('aria-selected')).toBe('true'));
    expect(bodyRows()[0]?.getAttribute('aria-selected')).toBe('false');

    fireEvent.keyDown(slowGrid(), { key: 'Home' });
    await waitFor(() => expect(bodyRows()[0]?.getAttribute('aria-selected')).toBe('true'));
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
    await waitFor(() =>
      expect(within(dataTable()).getAllByRole('row').slice(1)).toHaveLength(shapes.length),
    );

    fireEvent.click(within(dataTable()).getAllByRole('row')[1] as HTMLElement);
    expect(
      await screen.findByText('Showing the operations of one query shape'),
    ).toBeInTheDocument();
    await waitForRows(shapes[0]?.count ?? -1);
  });

  it('explains the edited command of the selected operation, and Reset brings back the profiled one', async () => {
    const api = await connectedApi();
    renderPanel(api);
    const list = await api.rpc.profiler.list({ ...SHOP, filter: LIMIT });
    await waitForRows(list.length);
    const target = list[0];
    expect(target).toBeDefined();

    fireEvent.click(bodyRows()[0] as HTMLElement);
    const pane = document.querySelector('.mg-profiler-detail') as HTMLElement;
    const original = formatCommandJson(userCommand(target?.command));
    const editor = await within(pane).findByLabelText<HTMLTextAreaElement>('Command');
    expect(editor.value).toBe(original);
    const reset = screen.getByRole('button', { name: 'Reset' });
    expect(reset).toBeDisabled();

    const events: ProfilerUiEvent[] = [];
    const unsubscribe = profilerUiEvents.subscribe((event) => events.push(event));
    try {
      const edited = { find: 'orders', filter: { status: 'shipped' } };
      fireEvent.change(editor, { target: { value: JSON.stringify(edited) } });
      fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
      expect(events.map((event) => event.type)).toEqual(['profiler:explain']);
      expect(events[0]?.ref.entry.id).toBe(target?.id);
      expect(events[0]?.ref.command).toEqual(edited);

      fireEvent.change(editor, { target: { value: '{ not json' } });
      expect(screen.getByRole('alert')).toHaveTextContent('The command is not valid JSON.');
      expect(screen.getByRole('button', { name: 'Explain' })).toBeDisabled();

      fireEvent.click(reset);
      expect(editor.value).toBe(original);
      expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
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

describe('ProfilerPanel restored before its connection', () => {
  it('asks to connect, then loads once the connection is up', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    renderPanel(api);
    expect(await screen.findByText('Connect to load the profiler of shop.')).toBeInTheDocument();
    await act(async () => {
      await api.rpc.connections.connect({ id: localConnectionId });
    });
    await waitFor(() =>
      expect(screen.queryByText('Connect to load the profiler of shop.')).toBeNull(),
    );
    expect(await screen.findByText(/Slow queries/)).toBeInTheDocument();
  });
});

describe('ProfilerPanel scenarios: one row per entry', () => {
  it.each(profilerScenarios.map((entry) => [entry.id, entry] as const))(
    'shows the op, duration, examined, returned and ratio cells of %s',
    async (_id, entry) => {
      await renderScenarios();
      const cells = cellsOf(rowFor(entry));
      expect(cells[CELL.ns]?.textContent).toBe(entry.ns);
      expect(cells[CELL.op]?.textContent).toBe(entry.op);
      expect(cells[CELL.duration]?.querySelector('.mg-profiler-duration')?.textContent).toBe(
        formatDuration(entry.millis),
      );
      expect(cells[CELL.examined]?.textContent).toBe(
        entry.docsExamined === undefined ? '-' : String(entry.docsExamined),
      );
      expect(cells[CELL.returned]?.textContent).toBe(
        entry.nreturned === undefined ? '-' : String(entry.nreturned),
      );
      expect(cells[CELL.ratio]?.textContent).toBe(expectedRatio(entry));
    },
  );

  it.each(profilerScenarios.map((entry) => [entry.id, entry] as const))(
    'shows the plan and a COLLSCAN badge only when the plan scans the collection for %s',
    async (_id, entry) => {
      await renderScenarios();
      const plan = cellsOf(rowFor(entry))[CELL.plan];
      expect(plan).toBeDefined();
      if (plan === undefined) {
        return;
      }
      const isScan = entry.planSummary?.includes('COLLSCAN') === true;
      expect(badgeTexts(plan).includes('COLLSCAN')).toBe(isScan);
      // A plan of only COLLSCAN shows the badge without repeating the text.
      expect(plan.querySelector('span.mg-profiler-cell')?.textContent).toBe(
        entry.planSummary?.trim() === 'COLLSCAN' ? undefined : (entry.planSummary ?? '-'),
      );
    },
  );

  it.each(profilerScenarios.map((entry) => [entry.id, entry] as const))(
    'shows the command, sort stage and explain state of %s in the detail pane',
    async (_id, entry) => {
      await renderScenarios();
      clickRow(entry);
      const expected = formatCommandJson(userCommand(entry.command));
      await waitFor(() => expect(commandText()).toBe(expected === '' ? undefined : expected));
      const sortStage = entry.hasSortStage === undefined ? '-' : entry.hasSortStage ? 'Yes' : 'No';
      expect(metricOf('Sort stage')).toBe(sortStage);
      if (entry.errMsg !== undefined) {
        expect(within(detailPane()).getByText(entry.errMsg)).toBeInTheDocument();
      }
      // An orphan getMore, an insert and other commands the server does not explain are disabled.
      const unexplainable = explainTarget(entry, userCommand(entry.command)) === undefined;
      expect(['sc-08-insert', 'sc-10-getmore-orphan'].every((id) => id !== entry.id)).toBe(
        !unexplainable,
      );
      const explain = screen.getByRole('button', { name: 'Explain' });
      if (unexplainable) {
        expect(explain).toBeDisabled();
      } else {
        expect(explain).toBeEnabled();
      }
    },
  );

  it('shows a sort badge in the table row of sc-03-sort, where hasSortStage is true', async () => {
    await renderScenarios();
    const entry = profilerScenarios.find((item) => item.id === 'sc-03-sort');
    expect(entry).toBeDefined();
    if (entry !== undefined) {
      expect(badgeTexts(rowFor(entry)).some((text) => /sort/i.test(text))).toBe(true);
    }
  });

  it('shows Error only on the entry that has an error message', async () => {
    await renderScenarios();
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(await screen.findByLabelText('Error'));
    const failing = profilerScenarios.filter((entry) => entry.errMsg !== undefined);
    expect(failing.map((entry) => entry.id)).toEqual(['sc-17-error']);
    for (const entry of profilerScenarios) {
      const cells = cellsOf(rowFor(entry));
      const error = cells[8];
      expect(badgeTexts(error ?? rowFor(entry)).includes('Error')).toBe(entry.errMsg !== undefined);
    }
  });

  it('shows the client or app of each entry, with a dash when neither is recorded', async () => {
    await renderScenarios();
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(await screen.findByLabelText('Client or app'));
    const expected = (entry: ProfileEntry) => entry.appName ?? entry.client ?? '-';
    for (const entry of profilerScenarios) {
      expect(cellsOf(rowFor(entry))[8]?.textContent).toBe(expected(entry));
    }
  });
});

describe('ProfilerPanel scenarios: durations, order and far past times', () => {
  it('shows a duration of one second or more in seconds, including the 12.5 s entry', async () => {
    await renderScenarios();
    const long = profilerScenarios.find((entry) => entry.id === 'sc-18-long');
    expect(long).toBeDefined();
    if (long !== undefined) {
      expect(cellsOf(rowFor(long))[CELL.duration]?.textContent).toContain('12.5 s');
    }
  });

  it('colours a long duration red and leaves a zero duration plain', async () => {
    await renderScenarios();
    const tone = (id: string) =>
      rowFor(
        profilerScenarios.find((entry) => entry.id === id) as ProfileEntry,
      ).querySelector<HTMLElement>('[data-testid="duration"]')?.dataset.tone;
    expect(tone('sc-18-long')).toBe('verySlow');
    expect(tone('sc-19-zero')).toBe('normal');
  });

  it('sorts the rows by time, newest first, with the far past entry last', async () => {
    await renderScenarios();
    const expected = [...profilerScenarios]
      .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
      .map((entry) => formatLocalTime(entry.ts));
    const shown = bodyRows().map((row) => cellsOf(row)[CELL.time]?.textContent);
    expect(shown).toEqual(expected);
  });

  it('shows the date of the far past entry, not only its time of day', async () => {
    await renderScenarios();
    const far = profilerScenarios.find((entry) => entry.id === 'sc-23-far-past');
    expect(far).toBeDefined();
    if (far !== undefined) {
      expect(cellsOf(rowFor(far))[CELL.time]?.textContent).toContain('1999');
    }
  });
});

describe('ProfilerPanel scenarios: filters and tabs', () => {
  it('keeps exactly the entries that isProblematic accepts under "Only problematic"', async () => {
    await renderScenarios();
    const problematic = profilerScenarios.filter(isProblematic);
    expect(problematic.length).toBeGreaterThan(0);
    expect(problematic.length).toBeLessThan(TOTAL);

    fireEvent.click(screen.getByLabelText('Only problematic'));
    await waitForRows(problematic.length);
    const shown = bodyRows().map((row) => cellsOf(row)[CELL.time]?.textContent);
    expect(new Set(shown)).toEqual(new Set(problematic.map((entry) => formatLocalTime(entry.ts))));

    fireEvent.click(screen.getByLabelText('Only problematic'));
    await waitForRows(TOTAL);
  });

  it('groups the entries into the shapes of core without crashing', async () => {
    await renderScenarios();
    fireEvent.click(screen.getByRole('tab', { name: 'Top shapes' }));
    const shapes = groupByShape(profilerScenarios);
    const table = document.querySelector('table');
    expect(table).not.toBeNull();
    await waitFor(() => expect(table?.querySelectorAll('tbody tr')).toHaveLength(shapes.length));

    const counts = Array.from(table?.querySelectorAll('tbody tr') ?? []).map((row) =>
      Number(row.querySelector('td')?.textContent),
    );
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(TOTAL);
    expect(counts.slice().sort()).toEqual(shapes.map((shape) => shape.count).sort());
    expectNoBadTokens();
  });

  it.each(['shop.orders', 'shop.customers'])(
    'offers the collection %s in the namespace filter',
    async (namespace) => {
      await renderScenarios();
      const input = screen.getByRole('textbox', { name: 'Namespace' });
      fireEvent.click(input);
      fireEvent.focus(input);
      expect(
        await screen.findByRole('option', { name: namespace, hidden: true }),
      ).toBeInTheDocument();
    },
  );

  it.each(['shop.events', 'shop.system.js'])(
    'offers %s in the namespace filter, since an entry uses it',
    async (namespace) => {
      await renderScenarios();
      const input = screen.getByRole('textbox', { name: 'Namespace' });
      fireEvent.click(input);
      fireEvent.focus(input);
      expect(
        await screen.findByRole('option', { name: namespace, hidden: true }),
      ).toBeInTheDocument();
    },
  );

  it('shows no bad token after each row is selected', async () => {
    await renderScenarios();
    for (const entry of profilerScenarios) {
      clickRow(entry);
      await waitFor(() => expect(within(detailPane()).getByText('Metrics')).toBeInTheDocument());
      expectNoBadTokens();
    }
  });

  it('shows no bad token in the rows, the shapes table or the filters', async () => {
    await renderScenarios();
    expectNoBadTokens();
    fireEvent.click(screen.getByLabelText('Only problematic'));
    expectNoBadTokens();
    fireEvent.click(screen.getByLabelText('Only problematic'));
    fireEvent.click(screen.getByRole('tab', { name: 'Top shapes' }));
    expect(bodyText()).toContain('shop.orders');
    expectNoBadTokens();
  });
});
