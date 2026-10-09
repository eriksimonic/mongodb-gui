import {
  DashboardLayoutSchema,
  defaultDashboardLayout,
  findPanel,
  unmetRequirement,
  type AppError,
  type DashboardLayout,
  type DashboardPanel,
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

export type DashboardWidth = DashboardPanel['w'];
export type DashboardHeight = DashboardPanel['h'];

/** Stacked charts take two columns, because their areas read better wide. Everything else takes one. */
export function defaultWidthFor(panel: PanelSpec): DashboardWidth {
  return panel.chart === 'stacked' ? 2 : 1;
}

/** Appends a panel at the end of the layout. A panel already on the dashboard stays where it is. */
export function addPanel(layout: DashboardLayout, panel: PanelSpec): DashboardLayout {
  if (layout.panels.some((item) => item.id === panel.id)) {
    return layout;
  }
  return {
    ...layout,
    panels: [...layout.panels, { id: panel.id, w: defaultWidthFor(panel), h: 1 }],
  };
}

export function removePanel(layout: DashboardLayout, id: string): DashboardLayout {
  return { ...layout, panels: layout.panels.filter((panel) => panel.id !== id) };
}

/** Moves the panel `fromId` to the position `toId` has. Unknown ids leave the layout unchanged. */
export function movePanel(layout: DashboardLayout, fromId: string, toId: string): DashboardLayout {
  const from = layout.panels.findIndex((panel) => panel.id === fromId);
  const to = layout.panels.findIndex((panel) => panel.id === toId);
  if (from < 0 || to < 0 || from === to) {
    return layout;
  }
  const panels = [...layout.panels];
  const [moved] = panels.splice(from, 1);
  if (moved === undefined) {
    return layout;
  }
  panels.splice(to, 0, moved);
  return { ...layout, panels };
}

export function resizePanel(
  layout: DashboardLayout,
  id: string,
  size: { readonly w?: DashboardWidth; readonly h?: DashboardHeight },
): DashboardLayout {
  return {
    ...layout,
    panels: layout.panels.map((panel) =>
      panel.id === id
        ? {
            ...panel,
            ...(size.w === undefined ? {} : { w: size.w }),
            ...(size.h === undefined ? {} : { h: size.h }),
          }
        : panel,
    ),
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

/** A placed panel with its catalogue entry. Panels whose requirement the connection lacks are left out. */
export interface VisiblePanel {
  readonly placed: DashboardPanel;
  readonly spec: PanelSpec;
}

/** The panels to draw, in layout order. Panel ids the catalogue no longer has are skipped. */
export function visiblePanels(
  layout: DashboardLayout,
  capabilities: ServerCapabilities,
): VisiblePanel[] {
  return layout.panels.flatMap((placed) => {
    const spec = findPanel(placed.id);
    if (spec === undefined || unmetRequirement(spec, capabilities) !== undefined) {
      return [];
    }
    return [{ placed, spec }];
  });
}
