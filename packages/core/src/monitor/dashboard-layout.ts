import { z } from 'zod';

/** Columns in the dashboard grid. A panel's width is 1, 2 or 3 of them. */
export const DASHBOARD_COLUMNS = 3;
export const DASHBOARD_LAYOUT_VERSION = 1;
/** Largest value the layout store accepts, in bytes of JSON. */
export const LAYOUT_VALUE_LIMIT_BYTES = 256 * 1024;
const MAX_LAYOUT_PANELS = 64;

export const DashboardPanelSchema = z.object({
  id: z.string().min(1).max(64),
  w: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  h: z.union([z.literal(1), z.literal(2)]),
});

export const DashboardLayoutSchema = z
  .object({
    version: z.literal(DASHBOARD_LAYOUT_VERSION),
    panels: z.array(DashboardPanelSchema).max(MAX_LAYOUT_PANELS),
  })
  .refine(
    (layout) => new Set(layout.panels.map((panel) => panel.id)).size === layout.panels.length,
    {
      message: 'A panel may appear only once in the dashboard layout.',
    },
  );

export type DashboardPanel = z.infer<typeof DashboardPanelSchema>;
export type DashboardLayout = z.infer<typeof DashboardLayoutSchema>;

/** The six cards the dashboard showed before panels could be chosen. */
export const DEFAULT_DASHBOARD_PANELS: readonly DashboardPanel[] = [
  { id: 'operations-by-type', w: 2, h: 1 },
  { id: 'connections', w: 1, h: 1 },
  { id: 'network', w: 1, h: 1 },
  { id: 'memory', w: 1, h: 1 },
  { id: 'queues', w: 1, h: 1 },
  { id: 'replication-lag', w: 2, h: 1 },
];

export function defaultDashboardLayout(): DashboardLayout {
  return {
    version: DASHBOARD_LAYOUT_VERSION,
    panels: DEFAULT_DASHBOARD_PANELS.map((panel) => ({ ...panel })),
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
