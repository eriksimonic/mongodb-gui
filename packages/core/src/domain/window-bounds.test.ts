import { describe, expect, it } from 'vitest';
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  clampBounds,
  parseWindowBounds,
  type WindowBounds,
} from './window-bounds';

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };

function bounds(overrides: Partial<WindowBounds>): WindowBounds {
  return { x: 100, y: 100, width: 1200, height: 800, maximized: false, ...overrides };
}

describe('clampBounds', () => {
  it('keeps bounds that already fit unchanged', () => {
    const saved = bounds({ x: 200, y: 120, width: 1400, height: 900 });
    expect(clampBounds(saved, AREA)).toEqual(saved);
  });

  it('moves a window that sits past the right and bottom edges back inside', () => {
    const result = clampBounds(bounds({ x: 1800, y: 1000 }), AREA);
    expect(result.x).toBe(AREA.width - result.width);
    expect(result.y).toBe(AREA.height - result.height);
  });

  it('moves a window saved on a disconnected display to the left edge of the area', () => {
    const result = clampBounds(bounds({ x: -4000, y: -300 }), AREA);
    expect(result).toMatchObject({ x: 0, y: 0 });
  });

  it('shrinks a window larger than the area, but not below the minimum size', () => {
    const big = clampBounds(bounds({ width: 4000, height: 3000 }), AREA);
    expect(big).toMatchObject({ width: AREA.width, height: AREA.height });

    const small = clampBounds(bounds({ width: 50, height: 50 }), AREA);
    expect(small).toMatchObject({ width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT });
  });

  it('fits into a small area offset from the origin', () => {
    const area = { x: 1920, y: 40, width: 1280, height: 700 };
    const result = clampBounds(bounds({ x: 0, y: 0, width: 1400, height: 900 }), area);
    expect(result).toEqual({ x: 1920, y: 40, width: 1280, height: 700, maximized: false });
  });

  it('keeps the maximized flag', () => {
    expect(clampBounds(bounds({ maximized: true }), AREA).maximized).toBe(true);
  });
});

describe('parseWindowBounds', () => {
  it('accepts a stored shape and rejects anything else', () => {
    expect(parseWindowBounds(bounds({}))).toEqual(bounds({}));
    expect(parseWindowBounds({ x: 1 })).toBeUndefined();
    expect(parseWindowBounds(null)).toBeUndefined();
    expect(parseWindowBounds(bounds({ width: 0 }))).toBeUndefined();
  });
});
