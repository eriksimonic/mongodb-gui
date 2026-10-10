// @vitest-environment jsdom
import '../test-support/browser-shims';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { groupByShape, type ProfileEntry } from '@mongo-gui/core';
import { profilerScenarios } from '../api/mock-profiler-scenarios';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { renderWithApp } from '../test-support/render';
import { ProfilerPanel } from './ProfilerPanel';
import { formatCommand, formatDuration, formatLocalTime, isProblematic } from './profiler-model';

const TOTAL = profilerScenarios.length;
const BAD_TOKENS = ['NaN', 'Infinity', 'undefined', '[object Object]'] as const;
const CELL = { time: 0, ns: 1, op: 2, duration: 3, examined: 4, returned: 5, ratio: 6, plan: 7 };

async function renderScenarios(): Promise<UiApi> {
  const api = createMockUiApi({ preset: 'unlocked', profilerEntries: profilerScenarios });
  await api.rpc.connections.connect({ id: localConnectionId });
  renderWithApp(<ProfilerPanel connectionId={localConnectionId} database="shop" />, { api });
  await waitForRows(TOTAL);
  return api;
}

function slowGrid(): HTMLElement {
  const grid = document.querySelector('.mg-profiler-scroll');
  if (grid === null) {
    throw new Error('no slow query grid on screen');
  }
  return grid as HTMLElement;
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

describe('ProfilerPanel scenarios: one row per entry', () => {
  it.each(profilerScenarios.map((entry) => [entry.id, entry] as const))(
    'shows the op, duration, examined, returned and ratio cells of %s',
    async (_id, entry) => {
      await renderScenarios();
      const cells = cellsOf(rowFor(entry));
      expect(cells[CELL.ns]?.textContent).toBe(entry.ns);
      expect(cells[CELL.op]?.textContent).toBe(entry.op);
      expect(cells[CELL.duration]?.querySelector('.mg-profiler-duration-label')?.textContent).toBe(
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
      expect(plan.querySelector('span.mg-profiler-cell')?.textContent).toBe(
        entry.planSummary ?? '-',
      );
    },
  );

  it.each(profilerScenarios.map((entry) => [entry.id, entry] as const))(
    'shows the command, sort stage and explain state of %s in the detail pane',
    async (_id, entry) => {
      await renderScenarios();
      clickRow(entry);
      await waitFor(() =>
        expect(detailPane().querySelector('pre')?.textContent).toBe(formatCommand(entry.command)),
      );
      const sortStage = entry.hasSortStage === undefined ? '-' : entry.hasSortStage ? 'Yes' : 'No';
      expect(metricOf('Sort stage')).toBe(sortStage);
      if (entry.errMsg !== undefined) {
        expect(within(detailPane()).getByText(entry.errMsg)).toBeInTheDocument();
      }
      const orphanGetMore =
        entry.op === 'getmore' &&
        (typeof entry.command !== 'object' ||
          entry.command === null ||
          !('originatingCommand' in entry.command));
      const explain = screen.getByRole('button', { name: 'Explain this' });
      if (orphanGetMore) {
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

  it('scales the duration bar to the slowest row in view, and leaves a zero duration empty', async () => {
    await renderScenarios();
    const bar = (id: string) =>
      rowFor(
        profilerScenarios.find((entry) => entry.id === id) as ProfileEntry,
      ).querySelector<HTMLElement>('[data-testid="duration-bar"]')?.style.width;
    expect(bar('sc-18-long')).toBe('100%');
    expect(bar('sc-19-zero')).toBe('0%');
    expect(bar('sc-02-ixscan')).toBe('0%');
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
      await waitFor(() => expect(detailPane().querySelector('pre')).not.toBeNull());
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
