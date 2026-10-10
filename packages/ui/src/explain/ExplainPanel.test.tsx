// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { appError, AppErrorException, normaliseExplain } from '@mongo-gui/core';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi, type MockUiApiOptions } from '../api/mock-rpc-client';
import {
  mockExplainPanel,
  mockExplainPanelFromRaw,
  rawFixture,
  withFailedShard,
} from '../api/explain-fixture-panels';
import type { UiApi } from '../api/ui-api';
import type { ExplainPanelState } from './explain-model';
import { renderWithApp } from '../test-support/render';
import { ExplainPanel } from './ExplainPanel';

// The JSON editor needs a layout engine, so tests use the text area stub.
vi.mock('../editor/JsonEditor', () => import('../test-support/json-editor-stub'));

const PANEL_ID = 'explain:test';
const FIND_CODE = `db.orders.find({ status: 'paid' }).sort({ createdAt: -1 })`;
const SORT_FIXTURE = '8.0.17/in-memory-sort';

function panelFor(fixture: string, code = FIND_CODE): ExplainPanelState {
  return mockExplainPanel({
    id: PANEL_ID,
    connectionId: localConnectionId,
    database: 'shop',
    code,
    fixture,
    collection: 'orders',
  });
}

async function connectedApi(options: MockUiApiOptions = {}): Promise<UiApi> {
  const api = createMockUiApi({ preset: 'unlocked', ...options });
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

function renderPanel(api: UiApi, panel: ExplainPanelState) {
  return renderWithApp(<ExplainPanel panelId={PANEL_ID} />, {
    api,
    initialState: { explainPanels: { [PANEL_ID]: panel } },
  });
}

/** The row of the plan tree that is selected, by its stage name. */
function selectedStageName(): string | null {
  const selected = document.querySelector('[role="treeitem"][aria-selected="true"]');
  return selected?.querySelector('.mg-explain-stage-name')?.textContent ?? null;
}

describe('ExplainPanel summary', () => {
  it('shows the index, examined counts and time from the fixture tree', async () => {
    const api = await connectedApi();
    const panel = panelFor(SORT_FIXTURE);
    renderPanel(api, panel);
    const summary = document.querySelector('.mg-explain-summary');
    if (summary === null || panel.outcome.state !== 'ready') {
      throw new Error('no summary on screen');
    }
    const { summary: facts } = panel.outcome.result.tree;
    expect(within(summary as HTMLElement).getByText('status_1')).toBeInTheDocument();
    expect(within(summary as HTMLElement).getByText('Docs examined').nextSibling?.textContent).toBe(
      (facts.docsExamined ?? 0).toLocaleString('en-US'),
    );
    expect(within(summary as HTMLElement).getByText('Keys examined').nextSibling?.textContent).toBe(
      (facts.keysExamined ?? 0).toLocaleString('en-US'),
    );
    expect(screen.getByText('Sort in memory')).toBeInTheDocument();
  });

  it('shows the collection scan in red for a plan without an index', async () => {
    const api = await connectedApi();
    renderPanel(api, panelFor('8.0.17/collscan'));
    expect(screen.getByText('Collection scan')).toBeInTheDocument();
  });
});

describe('ExplainPanel warnings', () => {
  it('selects the stage a warning points at when the warning is clicked', async () => {
    const api = await connectedApi();
    renderPanel(api, panelFor(SORT_FIXTURE));
    expect(selectedStageName()).toBeNull();
    const warning = screen.getByRole('button', { name: /IN_MEMORY_SORT/ });
    fireEvent.click(warning);
    expect(selectedStageName()).toBe('SORT');
  });

  it('shows the plain-language sentences from the core', async () => {
    const api = await connectedApi();
    renderPanel(api, panelFor(SORT_FIXTURE));
    expect(screen.getByText(/The planner chose the index status_1/)).toBeInTheDocument();
  });
});

describe('ExplainPanel plan tree', () => {
  it('moves between stages with the arrow keys and selects with Enter', async () => {
    const api = await connectedApi();
    renderPanel(api, panelFor(SORT_FIXTURE));
    const rows = screen.getAllByRole('treeitem');
    const first = rows[0];
    if (first === undefined) {
      throw new Error('no plan rows');
    }
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1] as HTMLElement, { key: 'Enter' });
    expect(rows[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('collapses a stage with Arrow Left and expands it with Arrow Right', async () => {
    const api = await connectedApi();
    renderPanel(api, panelFor(SORT_FIXTURE));
    const root = screen.getAllByRole('treeitem')[0] as HTMLElement;
    expect(root.getAttribute('aria-expanded')).toBe('true');
    const count = screen.getAllByRole('treeitem').length;
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    expect(root.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getAllByRole('treeitem')).toHaveLength(1);
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(screen.getAllByRole('treeitem')).toHaveLength(count);
  });

  it('shows the bounds of an index stage only when they are opened', async () => {
    const api = await connectedApi();
    renderPanel(api, panelFor(SORT_FIXTURE));
    const bounds = document.querySelector('.mg-explain-bounds') as HTMLDetailsElement | null;
    expect(bounds).not.toBeNull();
    expect(bounds?.open).toBe(false);
  });
});

describe('ExplainPanel verbosity and re-run', () => {
  it('runs the request again with the new verbosity when the verbosity changes', async () => {
    const api = await connectedApi();
    const run = vi.spyOn(api.rpc.explain, 'run');
    renderPanel(api, panelFor(SORT_FIXTURE));
    fireEvent.click(screen.getByText('queryPlanner'));
    await waitFor(() => {
      expect(run).toHaveBeenCalledWith({
        connectionId: localConnectionId,
        database: 'shop',
        code: FIND_CODE,
        verbosity: 'queryPlanner',
      });
    });
    await waitFor(() => {
      expect(screen.queryByText('Running explain')).not.toBeInTheDocument();
    });
  });

  it('re-runs the same request from the Re-run button', async () => {
    const api = await connectedApi();
    const run = vi.spyOn(api.rpc.explain, 'run');
    renderPanel(api, panelFor(SORT_FIXTURE));
    fireEvent.click(screen.getByRole('button', { name: /Re-run/ }));
    await waitFor(() => {
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ verbosity: 'executionStats' }));
    });
  });

  it('shows the error text when a run fails', async () => {
    const api = await connectedApi();
    vi.spyOn(api.rpc.explain, 'run').mockRejectedValueOnce(
      new AppErrorException(appError('COMMAND_FAILED', 'Explain failed', 'The server refused')),
    );
    renderPanel(api, panelFor(SORT_FIXTURE));
    fireEvent.click(screen.getByRole('button', { name: /Re-run/ }));
    expect(await screen.findByText(/The server refused/)).toBeInTheDocument();
  });
});

describe('ExplainPanel raw tab', () => {
  it('shows the raw explain document as JSON', async () => {
    const api = await connectedApi();
    const panel = panelFor(SORT_FIXTURE);
    renderPanel(api, panel);
    fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
    const raw = await screen.findByLabelText('Raw explain output');
    if (panel.outcome.state !== 'ready') {
      throw new Error('panel is not ready');
    }
    expect((raw as HTMLTextAreaElement).value).toBe(panel.outcome.result.rawEjson);
    expect((raw as HTMLTextAreaElement).value).toContain('"executionStats"');
  });
});

describe('ExplainPanel unknown plan shape', () => {
  it('shows the exact server document on the Raw tab when the plan is not recognised', async () => {
    const api = await connectedApi();
    // A hand-made document with no queryPlanner or stages, so the normaliser returns UNKNOWN.
    const serverDocument = { ok: 1, weirdShape: { nested: [1, 2, { deep: true }] } };
    const rawEjson = JSON.stringify(serverDocument, null, 2);
    const tree = normaliseExplain(serverDocument);
    expect(tree.command).toBe('unknown');
    const panel: ExplainPanelState = {
      ...panelFor(SORT_FIXTURE),
      outcome: {
        state: 'ready',
        result: { requestId: '6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', tree, rawEjson, elapsedMs: 4 },
      },
    };
    renderPanel(api, panel);
    expect(screen.getByText('No plan for this result')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
    const raw = await screen.findByLabelText('Raw explain output');
    expect((raw as HTMLTextAreaElement).value).toBe(rawEjson);
  });
});

describe('ExplainPanel loading state', () => {
  it('shows that the explain is running and no plan yet', async () => {
    const api = await connectedApi();
    const panel: ExplainPanelState = { ...panelFor(SORT_FIXTURE), outcome: { state: 'loading' } };
    renderPanel(api, panel);
    expect(screen.getByText('Running explain')).toBeInTheDocument();
    expect(document.querySelector('.mg-explain-tree')).toBeNull();
  });
});

describe('ExplainPanel states', () => {
  it('shows no plan with the refusal message for a refused statement', async () => {
    const api = await connectedApi();
    const panel: ExplainPanelState = {
      ...panelFor(SORT_FIXTURE),
      title: 'Explain',
      collection: undefined,
      outcome: { state: 'refused', message: 'Explain needs one collection query' },
    };
    renderPanel(api, panel);
    expect(screen.getByText('No plan for this result')).toBeInTheDocument();
    expect(screen.getByText('Explain needs one collection query')).toBeInTheDocument();
  });

  it('shows the error text of a failed explain', async () => {
    const api = await connectedApi();
    const panel: ExplainPanelState = {
      ...panelFor(SORT_FIXTURE),
      outcome: {
        state: 'error',
        error: { code: 'COMMAND_FAILED', message: 'Explain failed', detail: 'Not authorised' },
      },
    };
    renderPanel(api, panel);
    expect(screen.getByText('Explain failed: Not authorised')).toBeInTheDocument();
  });

  it('shows the plan of a sharded explain under one heading per shard', async () => {
    const api = await connectedApi();
    renderPanel(api, panelFor('sharded/find-sort'));
    expect(document.querySelector('.mg-explain-tree')?.textContent).toContain('shard shard01');
    expect(document.querySelector('.mg-explain-tree')?.textContent).toContain('shard shard02');
  });
});

/** A panel that holds a finished explain of a raw server document. */
function rawPanel(raw: unknown): ExplainPanelState {
  return mockExplainPanelFromRaw({
    id: PANEL_ID,
    connectionId: localConnectionId,
    database: 'shop',
    code: FIND_CODE,
    collection: 'orders',
    raw,
  });
}

/** The tree row of a stage by its name, as the first match in display order. */
function rowNamed(name: string): HTMLElement {
  const names = [...document.querySelectorAll<HTMLElement>('.mg-explain-stage-name')];
  const match = names.find((element) => element.textContent === name);
  if (match === undefined) {
    throw new Error(`no stage row named ${name}`);
  }
  return match.closest<HTMLElement>('[role="treeitem"]') ?? match;
}

describe('ExplainPanel stage catalogue', () => {
  it('shows a category icon and the catalogue description on hover for a known stage', async () => {
    const api = await connectedApi();
    renderPanel(api, panelFor('8.0.17/collscan'));
    const row = rowNamed('COLLSCAN');
    expect(row.querySelector('[data-category="scan"]')).not.toBeNull();
    fireEvent.mouseEnter(row.querySelector('.mg-explain-stage-head') as HTMLElement);
    expect(
      await screen.findByText(
        'Reads every document in the collection and applies the filter to each one.',
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Add an index on the fields in the filter/)).toBeInTheDocument();
  });

  it('shows a neutral icon and the raw name for a stage the catalogue does not know', async () => {
    const api = await connectedApi();
    const raw = {
      queryPlanner: {
        namespace: 'shop.orders',
        winningPlan: { stage: 'WARP_DRIVE', inputStage: { stage: 'COLLSCAN' } },
      },
      executionStats: { executionSuccess: true, nReturned: 0, executionStages: {} },
    };
    renderPanel(api, rawPanel(raw));
    expect(screen.getByText('Unknown stage')).toBeInTheDocument();
    const row = document.querySelector('[role="treeitem"]') as HTMLElement;
    expect(row.querySelector('[data-category="unknown"]')).not.toBeNull();
    expect(row.textContent).toContain('WARP_DRIVE');
  });
});

describe('ExplainPanel per-stage metrics', () => {
  it('shows the metrics that apply to each stage and no others', async () => {
    const api = await connectedApi();
    renderPanel(api, panelFor('8.0.17/collscan'));
    const scan = rowNamed('COLLSCAN').closest('[role="treeitem"]') as HTMLElement;
    expect(scan.textContent).toContain('Docs');
    expect(scan.textContent).not.toContain('Keys');
  });

  it('marks an examined-to-returned ratio badge on a fetch that reads many documents', async () => {
    const api = await connectedApi();
    renderPanel(api, panelFor('8.0.17/collscan'));
    const scan = rowNamed('COLLSCAN').closest('[role="treeitem"]') as HTMLElement;
    expect(scan.textContent).toContain('examined per returned');
  });
});

describe('ExplainPanel sub-trees', () => {
  it('labels the inner pipeline of a $lookup as a collapsible sub-tree', async () => {
    const api = await connectedApi();
    renderPanel(api, panelFor('8.0.17/lookup-pipeline', 'db.orders.aggregate([{ $lookup: {} }])'));
    const heading = screen.getByRole('button', {
      name: /inner pipeline of \$lookup from customers/,
    });
    expect(heading).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(heading);
    expect(heading).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the error message of a failed shard in red', async () => {
    const api = await connectedApi();
    const raw = withFailedShard(
      rawFixture('sharded/find-sort', 'executionStats'),
      'shard02 is down',
    );
    renderPanel(api, rawPanel(raw));
    const message = document.querySelector('.mg-explain-shard-error');
    expect(message?.textContent).toBe('shard02 is down');
    expect(rowNamed('SHARD_ERROR')).toBeInTheDocument();
  });
});

describe('ExplainPanel warning to stage', () => {
  it('scrolls the stage a warning points at into view and selects it', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const api = await connectedApi();
    renderPanel(api, panelFor('8.0.17/collscan'));
    scroll.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /COLLSCAN/ }));
    expect(selectedStageName()).toBe('COLLSCAN');
    expect(scroll).toHaveBeenCalled();
  });
});

describe('ExplainPanel rejected plans', () => {
  it('shows the rejected plan next to the winning one when Compare is pressed', async () => {
    const api = await connectedApi();
    renderPanel(
      api,
      panelFor('8.0.17/competing', `db.orders.find({ customerId: 7, status: 'paid' })`),
    );
    fireEvent.click(screen.getByText(/Rejected plans/));
    const compare = screen.getByRole('button', { name: 'Compare' });
    expect(compare).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('region', { name: 'Rejected plan 1' })).toBeNull();
    fireEvent.click(compare);
    expect(compare).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: 'Winning plan' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Rejected plan 1' })).toBeInTheDocument();
    fireEvent.click(compare);
    expect(screen.queryByRole('region', { name: 'Rejected plan 1' })).toBeNull();
  });
});

describe('ExplainPanel raw search', () => {
  it('moves to the next and previous match and wraps at both ends', async () => {
    const api = await connectedApi();
    const panel = panelFor(SORT_FIXTURE);
    renderPanel(api, panel);
    fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
    if (panel.outcome.state !== 'ready') {
      throw new Error('panel is not ready');
    }
    const total = countStage(panel);
    expect(total).toBeGreaterThan(1);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search raw output' }), {
      target: { value: 'stage' },
    });
    expect(screen.getByText(`1 of ${total}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByText(`2 of ${total}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(screen.getByText(`1 of ${total}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(screen.getByText(`${total} of ${total}`)).toBeInTheDocument();
  });

  it('says so when the search has no match', async () => {
    const api = await connectedApi();
    renderPanel(api, panelFor(SORT_FIXTURE));
    fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search raw output' }), {
      target: { value: 'no such text anywhere' },
    });
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });
});

/** The number of "stage" keys in the raw output of a ready panel. */
function countStage(panel: ExplainPanelState): number {
  if (panel.outcome.state !== 'ready') {
    return 0;
  }
  return panel.outcome.result.rawEjson.toLowerCase().split('stage').length - 1;
}
