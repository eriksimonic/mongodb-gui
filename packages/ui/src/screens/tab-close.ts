/** The panels that never close from a tab menu. The connections, welcome and output panels are fixed. */
export const FIXED_PANEL_IDS: ReadonlySet<string> = new Set(['connections', 'welcome', 'output']);

export function isFixedPanel(id: string): boolean {
  return FIXED_PANEL_IDS.has(id);
}

/**
 * The tab-menu actions. "this" closes the tab, "others" the other tabs of its group, "left" and
 * "right" the tabs of its group on that side, and "all" every tab.
 */
export type TabCloseMode = 'this' | 'others' | 'left' | 'right' | 'all';

/**
 * The ids to close for a tab-menu action. `ids` lists the panels of the group in displayed order,
 * or every panel for "all". The target tab itself is not in the result for "others", "left" and
 * "right". Fixed panels are never in the result.
 */
export function panelsToClose(
  ids: readonly string[],
  targetId: string,
  mode: TabCloseMode,
  isFixed: (id: string) => boolean,
): string[] {
  const index = ids.indexOf(targetId);
  let candidates: readonly string[];
  switch (mode) {
    case 'this':
      candidates = [targetId];
      break;
    case 'others':
      candidates = ids.filter((id) => id !== targetId);
      break;
    case 'left':
      candidates = index < 0 ? [] : ids.slice(0, index);
      break;
    case 'right':
      candidates = index < 0 ? [] : ids.slice(index + 1);
      break;
    case 'all':
      candidates = ids;
      break;
  }
  return candidates.filter((id) => !isFixed(id));
}
