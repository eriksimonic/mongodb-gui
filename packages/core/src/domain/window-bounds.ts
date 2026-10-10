import { z } from 'zod';

/** The layout key the main window stores its bounds under. */
export const WINDOW_BOUNDS_KEY = 'window:main';

/** Smallest width and height a restored window may take. Matches the window minimum. */
export const MIN_WINDOW_WIDTH = 1024;
export const MIN_WINDOW_HEIGHT = 600;

export const WindowBoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  maximized: z.boolean(),
});

export type WindowBounds = z.infer<typeof WindowBoundsSchema>;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Reads a stored value. Anything that does not match the shape gives undefined. */
export function parseWindowBounds(value: unknown): WindowBounds | undefined {
  const result = WindowBoundsSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

/**
 * Fits saved bounds into one display's work area. The size shrinks to the area when the area is
 * smaller, and the position moves until the whole window is inside. A window that was on a
 * disconnected monitor lands inside the display Electron picks for it.
 */
export function clampBounds(bounds: WindowBounds, area: Rect): WindowBounds {
  const width = clampNumber(bounds.width, Math.min(MIN_WINDOW_WIDTH, area.width), area.width);
  const height = clampNumber(bounds.height, Math.min(MIN_WINDOW_HEIGHT, area.height), area.height);
  return {
    x: clampNumber(bounds.x, area.x, area.x + area.width - width),
    y: clampNumber(bounds.y, area.y, area.y + area.height - height),
    width,
    height,
    maximized: bounds.maximized,
  };
}

/** Keeps a value inside [low, high]. When the range is inverted, the low bound wins. */
function clampNumber(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}
