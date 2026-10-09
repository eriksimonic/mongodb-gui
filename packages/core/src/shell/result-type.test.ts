import { describe, expect, it } from 'vitest';
import { toShellResultType } from './result-type';

describe('toShellResultType', () => {
  it('keeps names the runtime reports', () => {
    expect(toShellResultType('Cursor', {})).toBe('Cursor');
    expect(toShellResultType('InsertManyResult', {})).toBe('InsertManyResult');
    expect(toShellResultType('CursorIterationResult', {})).toBe('CursorIterationResult');
  });

  it('folds unknown names into other', () => {
    expect(toShellResultType('StreamProcessor', {})).toBe('other');
    expect(toShellResultType('constructor', {})).toBe('other');
  });

  it('classifies a null name by the value', () => {
    expect(toShellResultType(null, 'x')).toBe('string');
    expect(toShellResultType(null, 2)).toBe('number');
    expect(toShellResultType(null, true)).toBe('boolean');
    expect(toShellResultType(null, null)).toBe('null');
    expect(toShellResultType(undefined, undefined)).toBe('undefined');
    expect(toShellResultType(null, new Error('boom'))).toBe('Error');
    expect(toShellResultType(null, { a: 1 })).toBe('Document');
    expect(toShellResultType(null, [1])).toBe('Document');
    expect(toShellResultType(null, () => 1)).toBe('other');
  });
});
