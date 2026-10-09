import { PANEL_CATEGORIES, type PanelCategory, type PanelSpec } from '@mongo-gui/core';

/**
 * Panels whose title, description, category or series label contain every word of the query.
 * An empty query matches everything. Matching ignores case and extra spaces.
 */
export function searchPanels(panels: readonly PanelSpec[], query: string): PanelSpec[] {
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return [...panels];
  }
  return panels.filter((panel) => {
    const categoryLabel = PANEL_CATEGORIES.find((item) => item.id === panel.category)?.label ?? '';
    const haystack = [
      panel.title,
      panel.description,
      categoryLabel,
      ...panel.series.map((series) => series.label),
    ]
      .join(' ')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export interface PanelGroup {
  readonly category: PanelCategory;
  readonly label: string;
  readonly panels: readonly PanelSpec[];
}

/** The panels grouped by category, in the category order of the catalogue. Empty groups are left out. */
export function groupByCategory(panels: readonly PanelSpec[]): PanelGroup[] {
  return PANEL_CATEGORIES.flatMap((category) => {
    const members = panels.filter((panel) => panel.category === category.id);
    return members.length === 0
      ? []
      : [{ category: category.id, label: category.label, panels: members }];
  });
}
