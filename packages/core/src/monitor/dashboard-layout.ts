import { z } from 'zod';

export const DASHBOARD_LAYOUT_VERSION = 2;
/** Largest value the layout store accepts, in bytes of JSON. */
export const LAYOUT_VALUE_LIMIT_BYTES = 256 * 1024;
const MAX_LAYOUT_PANELS = 64;
const MAX_ROWS = 64;
const MAX_PANELS_PER_ROW = 6;

/** The smallest a row can be, in pixels. */
export const ROW_MIN_HEIGHT_PX = 140;
export const DEFAULT_ROW_HEIGHT_PX = 300;
const MAX_ROW_HEIGHT_PX = 2000;

export const DashboardPanelSchema = z.object({
  id: z.string().min(1).max(64),
  /** The share of the row width. The shares of a row sum to 1. */
  f: z.number().positive().max(1),
});

export const DashboardRowSchema = z.object({
  h: z.number().int().min(ROW_MIN_HEIGHT_PX).max(MAX_ROW_HEIGHT_PX),
  panels: z.array(DashboardPanelSchema).min(1).max(MAX_PANELS_PER_ROW),
});

/** Scales the shares of a row so they sum to exactly 1. */
export function normaliseRow<T extends { readonly f: number }>(panels: readonly T[]): T[] {
  const total = panels.reduce((sum, panel) => sum + panel.f, 0);
  return panels.map((panel) => ({ ...panel, f: total > 0 ? panel.f / total : 1 / panels.length }));
}

const LEGACY_COLUMNS = 3;
const LEGACY_ROW_PX = 280;

/**
 * Turns a layout saved before tiled rows into rows. A layout of width and height spans is flowed
 * three columns to a row. A free pixel layout is sorted top to bottom, then left to right, and
 * panels that start in the same band share a row.
 */
function migrateLayout(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1) {
    return value;
  }
  const panels = (value as { panels?: unknown }).panels;
  if (!Array.isArray(panels) || panels.length > MAX_LAYOUT_PANELS) {
    return value;
  }
  type Old = { id: string; w: number; h: number; rect?: { x: number; y: number; w: number; h: number } };
  const old = panels as Old[];
  if (old.some((panel) => typeof panel?.id !== 'string' || ![1, 2, 3].includes(panel.w) || ![1, 2].includes(panel.h))) {
    return value;
  }
  const rows: { h: number; panels: { id: string; f: number }[] }[] = [];
  if (old.some((panel) => panel.rect !== undefined)) {
    const placed = old
      .map((panel, index) => ({ panel, index, rect: panel.rect }))
      .sort((a, b) => (a.rect?.y ?? 1e9 + a.index) - (b.rect?.y ?? 1e9 + b.index) || (a.rect?.x ?? 0) - (b.rect?.x ?? 0));
    let bandBottom = -1;
    for (const { panel, rect } of placed) {
      const width = rect?.w ?? panel.w * 400;
      const top = rect?.y ?? bandBottom + 1;
      const last = rows.at(-1);
      if (last !== undefined && top < bandBottom && last.panels.length < MAX_PANELS_PER_ROW) {
        last.panels.push({ id: panel.id, f: width });
        last.h = Math.max(last.h, rect?.h ?? LEGACY_ROW_PX);
      } else {
        rows.push({ h: rect?.h ?? LEGACY_ROW_PX, panels: [{ id: panel.id, f: width }] });
        bandBottom = top + (rect?.h ?? LEGACY_ROW_PX);
      }
    }
  } else {
    let used = 0;
    for (const panel of old) {
      const last = rows.at(-1);
      if (last === undefined || used + panel.w > LEGACY_COLUMNS) {
        rows.push({ h: panel.h * LEGACY_ROW_PX, panels: [{ id: panel.id, f: panel.w }] });
        used = panel.w;
      } else {
        last.panels.push({ id: panel.id, f: panel.w });
        last.h = Math.max(last.h, panel.h * LEGACY_ROW_PX);
        used += panel.w;
      }
    }
  }
  return {
    version: DASHBOARD_LAYOUT_VERSION,
    rows: rows.map((row) => ({ h: Math.min(MAX_ROW_HEIGHT_PX, Math.max(ROW_MIN_HEIGHT_PX, Math.round(row.h))), panels: normaliseRow(row.panels) })),
  };
}

export const DashboardLayoutSchema = z
  .preprocess(
    migrateLayout,
    z.object({
      version: z.literal(DASHBOARD_LAYOUT_VERSION),
      rows: z.array(DashboardRowSchema).max(MAX_ROWS),
    }),
  )
  .refine((layout) => layoutPanelIds(layout).length <= MAX_LAYOUT_PANELS, {
    message: 'The dashboard layout has too many panels.',
  })
  .refine((layout) => new Set(layoutPanelIds(layout)).size === layoutPanelIds(layout).length, {
    message: 'A panel may appear only once in the dashboard layout.',
  })
  .transform((layout) => ({
    ...layout,
    rows: layout.rows.map((row) => ({ ...row, panels: normaliseRow(row.panels) })),
  }));

export type DashboardPanel = z.infer<typeof DashboardPanelSchema>;
export type DashboardRow = z.infer<typeof DashboardRowSchema>;
export type DashboardLayout = z.output<typeof DashboardLayoutSchema>;

/** The panel ids of a layout, top to bottom and left to right. */
export function layoutPanelIds(layout: { readonly rows: readonly DashboardRow[] }): string[] {
  return layout.rows.flatMap((row) => row.panels.map((panel) => panel.id));
}

/** The default rows: operations and connections, three small cards, and the replication lag. */
export const DEFAULT_DASHBOARD_ROWS: readonly DashboardRow[] = [
  {
    h: 340,
    panels: [
      { id: 'operations-by-type', f: 2 / 3 },
      { id: 'connections', f: 1 / 3 },
    ],
  },
  {
    h: DEFAULT_ROW_HEIGHT_PX,
    panels: [
      { id: 'network', f: 1 / 3 },
      { id: 'memory', f: 1 / 3 },
      { id: 'queues', f: 1 / 3 },
    ],
  },
  { h: DEFAULT_ROW_HEIGHT_PX, panels: [{ id: 'replication-lag', f: 1 }] },
];

/** The ids of the default panels, in order. */
export const DEFAULT_DASHBOARD_PANELS: readonly DashboardPanel[] = DEFAULT_DASHBOARD_ROWS.flatMap(
  (row) => row.panels,
);

export function defaultDashboardLayout(): DashboardLayout {
  return {
    version: DASHBOARD_LAYOUT_VERSION,
    rows: DEFAULT_DASHBOARD_ROWS.map((row) => ({
      h: row.h,
      panels: row.panels.map((panel) => ({ ...panel })),
    })),
  };
}

/** The layout store key for one connection's dashboard. */
export function dashboardLayoutKey(connectionId: string): string {
  return `layout:dashboard:${connectionId}`;
}

/** The stored layout, or undefined when the stored value is missing or does not match the schema. */
export function parseDashboardLayout(value: unknown): DashboardLayout | undefined {
  const parsed = DashboardLayoutSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The size of a layout value as JSON, the measure the store limit applies to. */
export function layoutValueBytes(value: unknown): number {
  const json = JSON.stringify(value) ?? 'null';
  let bytes = 0;
  for (const char of json) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code < 0x10000) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}
