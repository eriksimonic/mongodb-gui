import { describe, expect, it } from 'vitest';
import {
  createExportSink,
  EXPORT_PART_CHARS,
  exportHead,
  exportRow,
  exportTail,
  exportText,
  type ExportFormat,
  type ExportPart,
} from './result-export';
import { discoverColumns } from './result-model';
import type { JsonObject } from './result-model';

const documents: JsonObject[] = [
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a4b' },
    total: { $numberLong: '9007199254740993' },
    customer: { name: 'Ada, "AB"', city: 'Ljubljana' },
  },
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a4c' },
    tags: ['a', 'b'],
    customer: { name: 'Bo' },
  },
];

describe('exportText', () => {
  it('writes the documents as a canonical EJSON array that keeps every Long digit', () => {
    const json = exportText(documents, 'json');
    expect(JSON.parse(json)).toEqual(documents);
    expect(json).toContain('"$numberLong": "9007199254740993"');
  });

  it('writes one CSV column per flattened path, in first-seen order', () => {
    const lines = exportText(documents, 'csv').trim().split('\n');
    expect(lines[0]).toBe('_id,total,customer.name,customer.city,tags');
  });

  it('writes a row per document with empty cells for missing paths', () => {
    const lines = exportText(documents, 'csv').trim().split('\n');
    expect(lines[1]).toBe('65a1b2c3d4e5f60718293a4b,9007199254740993,"Ada, ""AB""",Ljubljana,');
    expect(lines[2]).toBe('65a1b2c3d4e5f60718293a4c,,Bo,,"[""a"",""b""]"');
  });
});

/** The export the way exportResult builds it: the head, a row per document, the tail, in parts. */
async function streamed(
  docs: readonly JsonObject[],
  format: ExportFormat,
): Promise<{ text: string; parts: { content: string; part: ExportPart }[] }> {
  const parts: { content: string; part: ExportPart }[] = [];
  const sink = createExportSink((content, part) => {
    parts.push({ content, part });
    return Promise.resolve();
  });
  const columns = format === 'csv' ? discoverColumns(docs) : [];
  await sink.push(exportHead(format, columns, docs.length));
  for (const [index, doc] of docs.entries()) {
    await sink.push(exportRow(format, columns, doc, index));
  }
  await sink.push(exportTail(format, docs.length));
  await sink.finish();
  return { text: parts.map((part) => part.content).join(''), parts };
}

describe('streamed export', () => {
  const rich: JsonObject[] = [
    ...documents,
    { _id: 3, text: 'h\u00e9llo \ud83d\ude00 "q"\nline', when: { $date: '2024-01-02T03:04:05Z' } },
    {
      _id: 4,
      nested: { deep: { list: [{ $numberDecimal: '1.5' }, { $binary: { base64: 'AA==' } }] } },
    },
  ];

  it.each([0, 1, 2, 4])('writes the JSON of %i documents like exportText', async (count) => {
    const docs = rich.slice(0, count);
    const { text } = await streamed(docs, 'json');
    expect(text).toBe(exportText(docs, 'json'));
    expect(text).toBe(JSON.stringify(docs, null, 2));
  });

  it.each([0, 1, 2, 4])('writes the CSV of %i documents like exportText', async (count) => {
    const docs = rich.slice(0, count);
    const { text } = await streamed(docs, 'csv');
    expect(text).toBe(exportText(docs, 'csv'));
  });

  it('takes the cells from the full document, not from the preview', () => {
    const preview: JsonObject = {
      _id: 1,
      big: { $mgTruncated: { t: 'string', n: 99, head: 'ab' } },
      $mgTruncated: { chars: 99 },
    };
    const full: JsonObject = { _id: 1, big: 'abcdef' };
    const columns = discoverColumns([preview]);
    expect(columns.map((column) => column.path)).toEqual(['_id', 'big']);
    expect(exportRow('csv', columns, full, 0)).toBe('1,abcdef\n');
  });

  it('writes one part as only, and several as first, next and last', async () => {
    const small = await streamed([{ a: 1 }], 'json');
    expect(small.parts.map((part) => part.part)).toEqual(['only']);

    const docs = Array.from({ length: 5 }, (_, n) => ({
      n,
      pad: 'y'.repeat(EXPORT_PART_CHARS / 2),
    }));
    const large = await streamed(docs, 'json');
    expect(large.parts.map((part) => part.part)).toEqual(['first', 'next', 'last']);
    expect(large.parts.every((part) => part.content.length <= EXPORT_PART_CHARS)).toBe(true);
    expect(large.text).toBe(JSON.stringify(docs, null, 2));
  });

  it('splits one text over the part size without cutting a surrogate pair', async () => {
    const text = `${'a'.repeat(EXPORT_PART_CHARS - 1)}\ud83d\ude00${'b'.repeat(10)}`;
    const parts: string[] = [];
    const sink = createExportSink((content) => {
      parts.push(content);
      return Promise.resolve();
    });
    await sink.push(text);
    await sink.finish();
    expect(parts).toHaveLength(2);
    expect(parts.join('')).toBe(text);
    expect(parts[0]?.endsWith('a')).toBe(true);
  });
});
