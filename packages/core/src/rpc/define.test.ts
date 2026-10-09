import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCall } from './define';

describe('defineCall', () => {
  it('returns the input and output schemas it was given', () => {
    const input = z.object({ id: z.string() });
    const output = z.boolean();
    const call = defineCall(input, output);
    expect(call.input).toBe(input);
    expect(call.output).toBe(output);
  });
});
