import { describe, expect, it } from 'vitest';
import {
  checkEjsonObject,
  checkLimit,
  DEFAULT_EXPORT_DRAFT,
  exportOptionsFor,
  exportProblemsOf,
  type ExportDraft,
} from './export-model';
import { defaultExportFileName, extensionOf, filterFor } from './transfer-model';

const DRAFT: ExportDraft = { ...DEFAULT_EXPORT_DRAFT, path: '/data/out.ndjson' };

describe('export model', () => {
  it('leaves an empty EJSON field unset and accepts an object', () => {
    expect(checkEjsonObject('The filter', '  ')).toEqual({ ok: true, value: undefined });
    expect(checkEjsonObject('The filter', '{"status": "paid"}')).toEqual({
      ok: true,
      value: '{"status": "paid"}',
    });
    expect(checkEjsonObject('The filter', '{"_id": {"$oid": "65b0c0ffee00000000000001"}}').ok).toBe(
      true,
    );
  });

  it('refuses text that is not JSON and JSON that is not an object', () => {
    const notJson = checkEjsonObject('The filter', 'ObjectId("65b0")');
    expect(notJson.ok).toBe(false);
    expect(!notJson.ok && notJson.message.startsWith('The filter is not valid extended JSON')).toBe(
      true,
    );

    expect(checkEjsonObject('The sort', '[1, 2]')).toEqual({
      ok: false,
      message: 'The sort must be a JSON object',
    });
    expect(checkEjsonObject('The sort', 'null').ok).toBe(false);
  });

  it('accepts a whole number above zero as a limit', () => {
    expect(checkLimit('')).toEqual({ ok: true, value: undefined });
    expect(checkLimit('50').ok).toBe(true);
    expect(checkLimit('0').ok).toBe(false);
    expect(checkLimit('2.5').ok).toBe(false);
    expect(checkLimit('ten').ok).toBe(false);
  });

  it('asks for a path before the export can start', () => {
    expect(exportProblemsOf({ ...DRAFT, path: '' })).toEqual([
      { field: 'path', message: 'Choose where to save the file' },
    ]);
    expect(exportProblemsOf(DRAFT)).toEqual([]);
  });

  it('sends only the options the user set', () => {
    expect(exportOptionsFor(DRAFT)).toEqual({ format: 'ndjson', ejsonMode: 'canonical' });
    expect(
      exportOptionsFor({
        ...DRAFT,
        filter: '{"status":"paid"}',
        sort: '{"createdAt":-1}',
        limit: '100',
        projection: '',
      }),
    ).toEqual({
      format: 'ndjson',
      ejsonMode: 'canonical',
      filterEjson: '{"status":"paid"}',
      sortEjson: '{"createdAt":-1}',
      limit: 100,
    });
  });

  it('adds the CSV options, with columns only when the user listed some', () => {
    expect(exportOptionsFor({ ...DRAFT, format: 'csv', delimiter: ';' })).toEqual({
      format: 'csv',
      ejsonMode: 'canonical',
      csv: { delimiter: ';', flattenArrays: 'json' },
    });
    expect(
      exportOptionsFor({
        ...DRAFT,
        format: 'csv',
        columns: [' sku ', '', 'total'],
        flattenArrays: 'join',
      }),
    ).toEqual({
      format: 'csv',
      ejsonMode: 'canonical',
      csv: { delimiter: ',', flattenArrays: 'join', columns: ['sku', 'total'] },
    });
  });

  it('builds the default file name and the save filter from the format', () => {
    expect(defaultExportFileName('shop', 'orders', 'json-array')).toBe('shop.orders.json');
    expect(extensionOf('csv')).toBe('csv');
    expect(filterFor('ndjson')).toEqual({
      name: 'NDJSON (one document per line)',
      extensions: ['ndjson'],
    });
  });
});
