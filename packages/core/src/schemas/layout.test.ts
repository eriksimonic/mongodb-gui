import { describe, expect, it } from 'vitest';
import { MAX_LAYOUT_BYTES, LayoutSetInputSchema, utf8ByteLength } from './layout';

describe('LayoutSetInputSchema', () => {
  it('accepts a JSON object under a valid key', () => {
    expect(
      LayoutSetInputSchema.safeParse({ key: 'dockview:main', value: { grid: {}, panels: {} } })
        .success,
    ).toBe(true);
  });

  it('accepts null, which clears a layout', () => {
    expect(LayoutSetInputSchema.safeParse({ key: 'dockview:main', value: null }).success).toBe(
      true,
    );
  });

  it('rejects a missing value, which is not JSON', () => {
    expect(LayoutSetInputSchema.safeParse({ key: 'dockview:main' }).success).toBe(false);
  });

  it('rejects a value with a cycle', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(LayoutSetInputSchema.safeParse({ key: 'dockview:main', value: cyclic }).success).toBe(
      false,
    );
  });

  it('rejects a value over 256 KB and accepts one just under it', () => {
    const under = 'x'.repeat(MAX_LAYOUT_BYTES - 2);
    expect(LayoutSetInputSchema.safeParse({ key: 'k', value: under }).success).toBe(true);
    const over = 'x'.repeat(MAX_LAYOUT_BYTES);
    expect(LayoutSetInputSchema.safeParse({ key: 'k', value: over }).success).toBe(false);
  });

  it('rejects a key with spaces or characters outside the allowed set', () => {
    expect(LayoutSetInputSchema.safeParse({ key: 'bad key', value: 1 }).success).toBe(false);
    expect(LayoutSetInputSchema.safeParse({ key: '', value: 1 }).success).toBe(false);
  });
});

describe('utf8ByteLength', () => {
  it('counts the bytes of each character class', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
  });
});
