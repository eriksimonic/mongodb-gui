import { describe, expect, it } from 'vitest';
import { panelsToClose } from './tab-close';

const ids = ['a', 'b', 'c', 'd', 'e'];
const none = (): boolean => false;

describe('panelsToClose', () => {
  it('closes only the target tab for "this"', () => {
    expect(panelsToClose(ids, 'c', 'this', none)).toEqual(['c']);
  });

  it('closes the other tabs of the group for "others", keeping the target', () => {
    expect(panelsToClose(ids, 'c', 'others', none)).toEqual(['a', 'b', 'd', 'e']);
  });

  it('closes the tabs to the left of the target', () => {
    expect(panelsToClose(ids, 'c', 'left', none)).toEqual(['a', 'b']);
  });

  it('closes the tabs to the right of the target', () => {
    expect(panelsToClose(ids, 'c', 'right', none)).toEqual(['d', 'e']);
  });

  it('returns nothing for left or right when the target is at that edge', () => {
    expect(panelsToClose(ids, 'a', 'left', none)).toEqual([]);
    expect(panelsToClose(ids, 'e', 'right', none)).toEqual([]);
  });

  it('closes every panel for "all"', () => {
    expect(panelsToClose(ids, 'c', 'all', none)).toEqual(ids);
  });

  it('skips fixed panels in every mode', () => {
    const isFixed = (id: string) => id === 'a' || id === 'd';
    expect(panelsToClose(ids, 'c', 'others', isFixed)).toEqual(['b', 'e']);
    expect(panelsToClose(ids, 'c', 'left', isFixed)).toEqual(['b']);
    expect(panelsToClose(ids, 'c', 'right', isFixed)).toEqual(['e']);
    expect(panelsToClose(ids, 'c', 'all', isFixed)).toEqual(['b', 'c', 'e']);
    expect(panelsToClose(ids, 'a', 'this', isFixed)).toEqual([]);
  });

  it('returns nothing when the target is not in the list for a side action', () => {
    expect(panelsToClose(ids, 'zz', 'left', none)).toEqual([]);
    expect(panelsToClose(ids, 'zz', 'right', none)).toEqual([]);
  });
});
