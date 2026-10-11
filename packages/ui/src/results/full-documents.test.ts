import { describe, expect, it, vi } from 'vitest';
import { COPY_MAX_CHARS, fullDocuments, fullDocumentText } from './full-documents';

const REF = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222';
const preview = (chars: number, withRef = true) => ({
  _id: 1,
  big: { $mgTruncated: { t: 'array', n: 9 } },
  $mgTruncated: withRef ? { ref: REF, chars } : { chars },
});

describe('fullDocumentText', () => {
  it('returns the JSON of a document sent whole, with no read', async () => {
    const read = vi.fn();
    expect(await fullDocumentText({ a: 1 }, read)).toBe('{"a":1}');
    expect(read).not.toHaveBeenCalled();
  });

  it('reads a preview by its ref', async () => {
    const read = vi.fn().mockResolvedValue('{"_id":1,"big":[1,2]}');
    expect(await fullDocumentText(preview(100), read)).toBe('{"_id":1,"big":[1,2]}');
    expect(read).toHaveBeenCalledWith(REF);
  });

  it('applies the field edits saved since the preview on top of the stored text', async () => {
    const edited = {
      ...preview(100),
      $mgTruncated: {
        ref: REF,
        chars: 100,
        edits: [
          { path: 'a.b', value: 5 },
          { path: 'gone', unset: true },
        ],
      },
    };
    const read = vi.fn().mockResolvedValue('{"_id":1,"a":{"b":1},"gone":2,"big":[1]}');
    expect(JSON.parse(await fullDocumentText(edited, read))).toEqual({
      _id: 1,
      a: { b: 5 },
      big: [1],
    });
  });

  it('throws NOT_FOUND for a preview that has no ref', async () => {
    const read = vi.fn();
    await expect(fullDocumentText(preview(100, false), read)).rejects.toMatchObject({
      error: { code: 'NOT_FOUND', message: 'The full document was not kept. Run the query again.' },
    });
    expect(read).not.toHaveBeenCalled();
  });
});

describe('fullDocuments', () => {
  it('passes documents sent whole through and parses the full text of previews', async () => {
    const read = vi.fn().mockResolvedValue('{"_id":1,"big":[1,2]}');
    const docs = await fullDocuments([{ a: 1 }, preview(100)], read, COPY_MAX_CHARS);
    expect(docs).toEqual([{ a: 1 }, { _id: 1, big: [1, 2] }]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('refuses an estimate over the limit before it reads anything', async () => {
    const read = vi.fn();
    await expect(fullDocuments([preview(600), preview(600)], read, 1000)).rejects.toMatchObject({
      error: { code: 'VALIDATION', message: 'Too large to copy. Use Export.' },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('does not count documents sent whole against the limit', async () => {
    const read = vi.fn();
    const whole = { _id: 1, text: 'x'.repeat(2000) };
    // Whole documents are already in memory, so copying them has no size to refuse.
    await expect(fullDocuments([whole, whole, whole], read, 1000)).resolves.toHaveLength(3);
    expect(read).not.toHaveBeenCalled();
  });

  it('reads previews one at a time', async () => {
    let active = 0;
    let peak = 0;
    const read = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return '{"_id":1}';
    });
    await fullDocuments([preview(10), preview(10), preview(10)], read, COPY_MAX_CHARS);
    expect(read).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });
});
