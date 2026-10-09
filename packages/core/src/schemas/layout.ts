import { z } from 'zod';

/** Largest serialised layout value the store accepts. */
export const MAX_LAYOUT_BYTES = 256 * 1024;

export const LayoutKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9:._-]+$/, 'The layout key uses letters, digits and : . _ - only.');

/** Serialises a value as JSON. Undefined, functions and symbols give undefined. Cycles throw. */
function toJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Bytes the string takes as UTF-8. Counted by hand, so no global encoder is needed. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export const LayoutSetInputSchema = z
  .object({ key: LayoutKeySchema, value: z.unknown() })
  .superRefine((input, ctx) => {
    const json = toJson(input.value);
    if (json === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'The layout value must be JSON.',
      });
      return;
    }
    if (utf8ByteLength(json) > MAX_LAYOUT_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'The layout value must be 256 KB or smaller.',
      });
    }
  });

export const LayoutGetOutputSchema = z.object({ value: z.unknown().nullable() });
