// @vitest-environment jsdom
import { PANEL_CATALOG, PANEL_CATEGORIES, findPanel, type PanelSpec } from '@mongo-gui/core';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { AddPanelPicker } from './AddPanelPicker';
import { groupByCategory, searchPanels } from './panel-picker';

function panel(id: string): PanelSpec {
  const found = findPanel(id);
  if (found === undefined) {
    throw new Error(`missing panel ${id}`);
  }
  return found;
}

describe('searchPanels', () => {
  it('returns every panel for an empty or blank query', () => {
    expect(searchPanels(PANEL_CATALOG, '')).toHaveLength(PANEL_CATALOG.length);
    expect(searchPanels(PANEL_CATALOG, '   ')).toHaveLength(PANEL_CATALOG.length);
  });

  it('matches every word, ignoring case, across title, description and series labels', () => {
    const cache = searchPanels(PANEL_CATALOG, 'WIREDTIGER cache').map((item) => item.id);
    expect(cache).toContain('wt-cache');
    // Every word must match, so panels outside the WiredTiger category drop out.
    expect(cache).not.toContain('memory');
    expect(cache).not.toContain('wt-checkpoints');
    expect(searchPanels(PANEL_CATALOG, 'checkpoints').map((item) => item.id)).toContain(
      'wt-checkpoints',
    );
    expect(searchPanels(PANEL_CATALOG, 'no such panel')).toEqual([]);
  });

  it('matches the category label', () => {
    const ids = searchPanels(PANEL_CATALOG, 'sessions').map((item) => item.id);
    expect(ids).toContain('logical-sessions');
    expect(ids).toContain('cursors');
  });
});

describe('groupByCategory', () => {
  it('groups panels in catalogue category order and leaves out empty groups', () => {
    const groups = groupByCategory([panel('network'), panel('connections'), panel('asserts')]);
    expect(groups.map((group) => group.category)).toEqual([
      'operations',
      'io-and-network',
      'errors',
    ]);
    expect(groups[0]?.panels.map((item) => item.id)).toEqual(['connections']);
  });

  it('covers every panel once across all groups', () => {
    const groups = groupByCategory(PANEL_CATALOG);
    const ids = groups.flatMap((group) => group.panels.map((item) => item.id));
    expect(ids).toHaveLength(PANEL_CATALOG.length);
    expect(groups.map((group) => group.label)).toEqual(
      PANEL_CATEGORIES.filter((category) =>
        PANEL_CATALOG.some((item) => item.category === category.id),
      ).map((category) => category.label),
    );
  });
});

describe('AddPanelPicker', () => {
  it('filters the rows as the user types and reports an empty search', () => {
    renderWithApp(
      <AddPanelPicker
        opened
        onClose={vi.fn()}
        addedIds={new Set()}
        capabilities={{ wiredTiger: true, replicaSet: true }}
        onAdd={vi.fn()}
      />,
    );
    const rows = screen.getAllByTestId('picker-row');
    expect(rows.length).toBe(PANEL_CATALOG.length);

    fireEvent.change(screen.getByLabelText('Search panels'), {
      target: { value: 'nothing matches this' },
    });
    expect(screen.queryAllByTestId('picker-row')).toHaveLength(0);
    expect(screen.getByText('No panels match this search.')).toBeInTheDocument();
  });

  it('gives each category a labelled group', () => {
    renderWithApp(
      <AddPanelPicker
        opened
        onClose={vi.fn()}
        addedIds={new Set()}
        capabilities={{ wiredTiger: true, replicaSet: true }}
        onAdd={vi.fn()}
      />,
    );
    const group = document.querySelector('[data-category="replication"]');
    expect(group).not.toBeNull();
    expect(within(group as HTMLElement).getByText('Replication lag')).toBeInTheDocument();
  });
});
