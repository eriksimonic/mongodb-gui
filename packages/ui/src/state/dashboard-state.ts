import {
  DashboardLayoutSchema,
  defaultDashboardLayout,
  DEFAULT_ROW_HEIGHT_PX,
  findPanel,
  layoutPanelIds,
  normaliseRow,
  ROW_MIN_HEIGHT_PX,
  unmetRequirement,
  type AppError,
  type DashboardLayout,
  type DashboardRow,
  type PanelSpec,
  type ServerCapabilities,
} from '@mongo-gui/core';

/** A layout change is saved once no further change has arrived for this long. */
export const DASHBOARD_SAVE_DELAY_MS = 500;

/** What the store keeps per connection for the dashboard. */
export interface DashboardView {
  readonly layout: DashboardLayout;
  /** True once the saved layout has been read. Saves wait for it, so they never overwrite an unread layout. */
  readonly loaded: boolean;
  /** The last failed read or write. A later successful save clears it. */
  readonly error: AppError | undefined;
  /** Set when the stored layout was invalid and the default is shown instead. The next change clears it. */
  readonly notice: string | undefined;
}

/** The one-line notice shown after a stored layout was reset. */
export const RESET_NOTICE =
  'The saved layout was not valid, so the dashboard was reset to the default.';

export const EMPTY_DASHBOARD_VIEW: DashboardView = {
  layout: defaultDashboardLayout(),
  loaded: false,
  error: undefined,
  notice: undefined,
};

/** A pure change to a layout. The store keeps these until the saved layout is read. */
export type LayoutChange = (layout: DashboardLayout) => DashboardLayout;

/** Most panels a row takes when one is added or dropped beside another. */
export const MAX_PANELS_PER_ROW = 4;

function withRows(layout: DashboardLayout, rows: readonly DashboardRow[]): DashboardLayout {
  return {
    ...layout,
    rows: rows
      .filter((row) => row.panels.length > 0)
      .map((row) => ({ ...row, panels: normaliseRow(row.panels) })),
  };
}

/** Puts a panel into the last row with equal widths when the row has room, else in a new row. */
export function addPanel(layout: DashboardLayout, panel: PanelSpec): DashboardLayout {
  if (layoutPanelIds(layout).includes(panel.id)) {
    return layout;
  }
  const last = layout.rows.at(-1);
  if (last !== undefined && last.panels.length < MAX_PANELS_PER_ROW) {
    const equal = [...last.panels, { id: panel.id, f: 1 }].map((item) => ({ ...item, f: 1 }));
    return withRows(layout, [...layout.rows.slice(0, -1), { ...last, panels: equal }]);
  }
  return withRows(layout, [
    ...layout.rows,
    { h: DEFAULT_ROW_HEIGHT_PX, panels: [{ id: panel.id, f: 1 }] },
  ]);
}

/** Removes a panel. Its row shares the width among the rest, and an emptied row goes. */
export function removePanel(layout: DashboardLayout, id: string): DashboardLayout {
  if (!layoutPanelIds(layout).includes(id)) {
    return layout;
  }
  return withRows(
    layout,
    layout.rows.map((row) => ({ ...row, panels: row.panels.filter((panel) => panel.id !== id) })),
  );
}

/** Where a dragged panel lands relative to another: beside it in its row, or in a new row. */
export type DropPlace = 'left' | 'right' | 'above' | 'below';

/**
 * Moves a panel next to another panel, or into a new row above or below the target's row. The row
 * the panel left shares its width among the rest. A drop on itself does nothing.
 */
export function movePanel(
  layout: DashboardLayout,
  id: string,
  targetId: string,
  place: DropPlace,
): DashboardLayout {
  const ids = layoutPanelIds(layout);
  if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) {
    return layout;
  }
  const sourceRow = layout.rows.find((row) => row.panels.some((panel) => panel.id === id));
  const height = sourceRow?.h ?? DEFAULT_ROW_HEIGHT_PX;
  const rows = layout.rows.map((row) => ({
    ...row,
    panels: row.panels.filter((panel) => panel.id !== id),
  }));
  const targetIndex = rows.findIndex((row) => row.panels.some((panel) => panel.id === targetId));
  const target = rows[targetIndex];
  if (target === undefined) {
    return layout;
  }
  const beside = (place === 'left' || place === 'right') && target.panels.length < MAX_PANELS_PER_ROW;
  if (beside) {
    const at = target.panels.findIndex((panel) => panel.id === targetId) + (place === 'right' ? 1 : 0);
    const panels = [...target.panels.map((panel) => ({ ...panel, f: 1 }))];
    panels.splice(at, 0, { id, f: 1 });
    rows[targetIndex] = { ...target, panels };
  } else {
    const newRow: DashboardRow = { h: height, panels: [{ id, f: 1 }] };
    rows.splice(place === 'above' || place === 'left' ? targetIndex : targetIndex + 1, 0, newRow);
  }
  return withRows(layout, rows);
}

/**
 * Moves the boundary between two neighbours of a row. `leftShare` is the left panel's share of the
 * two panels' combined width, from 0 to 1. The other panels keep their widths.
 */
export function splitPanels(
  layout: DashboardLayout,
  leftId: string,
  rightId: string,
  leftShare: number,
): DashboardLayout {
  const share = Math.min(1, Math.max(0, leftShare));
  return withRows(
    layout,
    layout.rows.map((row) => {
      const left = row.panels.find((panel) => panel.id === leftId);
      const right = row.panels.find((panel) => panel.id === rightId);
      if (left === undefined || right === undefined) {
        return row;
      }
      const sum = left.f + right.f;
      return {
        ...row,
        panels: row.panels.map((panel) =>
          panel.id === leftId
            ? { ...panel, f: sum * share }
            : panel.id === rightId
              ? { ...panel, f: sum * (1 - share) }
              : panel,
        ),
      };
    }),
  );
}

/** Sets the height of a row. Rows below it move with it. */
export function setRowHeight(layout: DashboardLayout, rowIndex: number, height: number): DashboardLayout {
  const h = Math.max(ROW_MIN_HEIGHT_PX, Math.round(height));
  return {
    ...layout,
    rows: layout.rows.map((row, index) => (index === rowIndex ? { ...row, h } : row)),
  };
}

export function resetLayout(): DashboardLayout {
  return defaultDashboardLayout();
}

export type StoredLayout =
  | { readonly state: 'missing' }
  | { readonly state: 'valid'; readonly layout: DashboardLayout }
  /** `summary` names the failing paths and rules. It never contains the stored value. */
  | { readonly state: 'invalid'; readonly summary: string };

const MAX_ISSUES_IN_SUMMARY = 5;

/** Checks a stored value against the layout schema. A null or missing value is not an error. */
export function readStoredLayout(value: unknown): StoredLayout {
  if (value === null || value === undefined) {
    return { state: 'missing' };
  }
  const parsed = DashboardLayoutSchema.safeParse(value);
  if (parsed.success) {
    return { state: 'valid', layout: parsed.data };
  }
  const summary = parsed.error.issues
    .slice(0, MAX_ISSUES_IN_SUMMARY)
    .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.code}`)
    .join('; ');
  return { state: 'invalid', summary };
}

/** A panel to draw: its place in the saved row, its catalogue entry and its share of the row. */
export interface VisiblePanel {
  readonly id: string;
  readonly spec: PanelSpec;
  readonly f: number;
}

export interface VisibleRow {
  /** The index in the saved layout, which the row actions use. */
  readonly index: number;
  readonly h: number;
  readonly panels: readonly VisiblePanel[];
}

/**
 * The rows to draw. Panels whose requirement the connection lacks, and ids the catalogue no longer
 * has, are left out, and the rest share the full row width. A row left empty is skipped.
 */
export function visibleRows(layout: DashboardLayout, capabilities: ServerCapabilities): VisibleRow[] {
  return layout.rows.flatMap((row, index) => {
    const shown = row.panels.flatMap((placed) => {
      const spec = findPanel(placed.id);
      return spec === undefined || unmetRequirement(spec, capabilities) !== undefined
        ? []
        : [{ id: placed.id, spec, f: placed.f }];
    });
    return shown.length === 0 ? [] : [{ index, h: row.h, panels: normaliseRow(shown) }];
  });
}
