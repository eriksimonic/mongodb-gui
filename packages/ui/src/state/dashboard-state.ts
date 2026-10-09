import {
  defaultDashboardLayout,
  findPanel,
  parseDashboardLayout,
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
}

export const EMPTY_DASHBOARD_VIEW: DashboardView = {
  layout: defaultDashboardLayout(),
  loaded: false,
  error: undefined,
};

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

/** The layout a stored value gives, or the default when the value is missing or invalid. */
export function layoutFromStored(value: unknown): DashboardLayout {
  return parseDashboardLayout(value) ?? defaultDashboardLayout();
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
