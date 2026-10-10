import { describe, expect, it } from 'vitest';
import { COLLAPSED_OUTPUT_PX, isOutputCollapsed, nextOutputHeight } from './output-collapse';

describe('output panel collapse', () => {
  it('treats the tab strip height, and a pixel or two more, as collapsed', () => {
    expect(isOutputCollapsed(COLLAPSED_OUTPUT_PX)).toBe(true);
    expect(isOutputCollapsed(COLLAPSED_OUTPUT_PX + 2)).toBe(true);
    expect(isOutputCollapsed(120)).toBe(false);
  });

  it('collapses an expanded group to the tab strip', () => {
    expect(nextOutputHeight(240, undefined, 800)).toBe(COLLAPSED_OUTPUT_PX);
  });

  it('expands to the remembered height', () => {
    expect(nextOutputHeight(COLLAPSED_OUTPUT_PX, 310, 800)).toBe(310);
  });

  it('expands to the default share when nothing usable is remembered', () => {
    expect(nextOutputHeight(COLLAPSED_OUTPUT_PX, undefined, 800)).toBe(240);
    expect(nextOutputHeight(COLLAPSED_OUTPUT_PX, COLLAPSED_OUTPUT_PX, 800)).toBe(240);
  });
});
