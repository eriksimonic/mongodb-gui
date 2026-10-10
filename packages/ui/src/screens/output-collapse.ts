import type { DockviewApi, DockviewGroupPanel } from 'dockview-react';

/** The height of a collapsed output group: the tab strip and nothing else. */
export const COLLAPSED_OUTPUT_PX = 35;
/** A group at or under this height counts as collapsed. The splitter can leave it a pixel off. */
const COLLAPSED_THRESHOLD_PX = COLLAPSED_OUTPUT_PX + 4;
/** The share of the dock height the output group takes when it expands without a remembered height. */
export const OUTPUT_SHARE = 0.3;

/** True when the group is folded down to its tab strip. */
export function isOutputCollapsed(height: number): boolean {
  return height <= COLLAPSED_THRESHOLD_PX;
}

/**
 * The height the output group takes after a toggle. A collapsed group expands to the remembered
 * height, or to its default share of the dock. An expanded group collapses to its tab strip.
 */
export function nextOutputHeight(
  current: number,
  remembered: number | undefined,
  dockHeight: number,
): number {
  if (isOutputCollapsed(current)) {
    const fallback = Math.round(dockHeight * OUTPUT_SHARE);
    return remembered !== undefined && !isOutputCollapsed(remembered) ? remembered : fallback;
  }
  return COLLAPSED_OUTPUT_PX;
}

/** The group that holds the fixed output panel, if the layout still has one. */
export function outputGroup(api: DockviewApi): DockviewGroupPanel | undefined {
  return api.getPanel('output')?.group;
}

/**
 * Lets the output group shrink to its tab strip. Dockview gives every group a minimum height of
 * about a hundred pixels, which would stop the fold. Called once the layout is in place.
 */
export function allowOutputCollapse(api: DockviewApi): void {
  outputGroup(api)?.api.setConstraints({ minimumHeight: COLLAPSED_OUTPUT_PX });
}

let rememberedHeight: number | undefined;

/**
 * Folds the output group to its tab strip, or unfolds it. The height before a collapse is kept for
 * the next expand, for the life of the window. The saved layout stores the result either way.
 */
export function toggleOutputPanel(api: DockviewApi): void {
  const group = outputGroup(api);
  if (group === undefined) {
    return;
  }
  allowOutputCollapse(api);
  const current = group.api.height;
  if (!isOutputCollapsed(current)) {
    rememberedHeight = current;
  }
  group.api.setSize({ height: nextOutputHeight(current, rememberedHeight, api.height) });
}
