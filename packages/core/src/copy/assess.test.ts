import { describe, expect, it } from 'vitest';
import { assessCopy, type CopyFacts } from './assess';

const SERVER = { serverVersion: '8.0.17', fcv: '8.0', topology: 'replicaSet' } as const;

function facts(overrides: Partial<CopyFacts> = {}): CopyFacts {
  return {
    source: SERVER,
    target: SERVER,
    tools: { selected: '100.19.1', installed: ['100.19.1'], available: ['100.19.1'] },
    sameServer: false,
    options: {
      sourceDatabase: 'shop',
      targetDatabase: 'shop_copy',
      items: [{ source: 'orders', target: 'orders' }],
      mode: 'replace',
    },
    sourceNamespaces: [{ database: 'shop', collection: 'orders', type: 'collection' }],
    targetNamespaces: [],
    ...overrides,
  };
}

const codes = (findings: { code: string }[]) => findings.map((item) => item.code);

describe('assessCopy', () => {
  it('reports nothing for a plain copy to another database', () => {
    expect(assessCopy(facts())).toEqual([]);
  });

  it('blocks a copy onto itself on the same server', () => {
    const findings = assessCopy(
      facts({ sameServer: true, options: { ...facts().options, targetDatabase: 'shop' } }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'copy-overlap', severity: 'block' }),
    );
  });

  it('blocks a partial rename that writes onto a collection the copy reads', () => {
    const findings = assessCopy(
      facts({
        sameServer: true,
        options: {
          sourceDatabase: 'shop',
          targetDatabase: 'shop',
          items: [
            { source: 'orders', target: 'invoices' },
            { source: 'invoices', target: 'archive' },
          ],
          mode: 'replace',
        },
        sourceNamespaces: [
          { database: 'shop', collection: 'orders', type: 'collection' },
          { database: 'shop', collection: 'invoices', type: 'collection' },
        ],
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: 'copy-overlap',
        severity: 'block',
        detail: 'shop.invoices',
      }),
    );
  });

  it('blocks a swap of two collection names', () => {
    const findings = assessCopy(
      facts({
        sameServer: true,
        options: {
          sourceDatabase: 'shop',
          targetDatabase: 'shop',
          items: [
            { source: 'a', target: 'b' },
            { source: 'b', target: 'a' },
          ],
          mode: 'replace',
        },
        sourceNamespaces: [
          { database: 'shop', collection: 'a', type: 'collection' },
          { database: 'shop', collection: 'b', type: 'collection' },
        ],
      }),
    );
    expect(codes(findings)).toContain('copy-overlap');
  });

  it('allows the same names on another server', () => {
    const findings = assessCopy(facts({ options: { ...facts().options, targetDatabase: 'shop' } }));
    expect(codes(findings)).not.toContain('copy-overlap');
  });

  it('allows the same names in another database on the same server', () => {
    expect(codes(assessCopy(facts({ sameServer: true })))).not.toContain('copy-overlap');
  });

  it('blocks when no installed or downloadable tools version fits both servers', () => {
    const findings = assessCopy(
      facts({
        target: { serverVersion: '9.0.0', fcv: '9.0', topology: 'replicaSet' },
        tools: { selected: '100.10.0', installed: ['100.10.0'], available: [] },
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'tools-too-old-for-server', severity: 'block' }),
    );
  });

  it('warns about a time series rename on tools older than 100.16.0', () => {
    const timeseries = facts({
      sourceNamespaces: [{ database: 'shop', collection: 'orders', type: 'timeseries' }],
      tools: { selected: '100.15.0', installed: ['100.15.0'], available: [] },
    });
    const renamed = {
      ...timeseries,
      options: { ...timeseries.options, items: [{ source: 'orders', target: 'orders2' }] },
    };
    expect(assessCopy(renamed)).toContainEqual(
      expect.objectContaining({ code: 'copy-timeseries-rename', severity: 'warning' }),
    );
    expect(codes(assessCopy({ ...renamed, tools: facts().tools }))).not.toContain(
      'copy-timeseries-rename',
    );
  });

  it('warns that replace refills a time series target in place', () => {
    const withTarget = facts({
      targetNamespaces: [{ database: 'shop_copy', collection: 'orders', type: 'timeseries' }],
    });
    expect(assessCopy(withTarget)).toContainEqual(
      expect.objectContaining({ code: 'copy-timeseries-target', severity: 'warning' }),
    );
    const merge = { ...withTarget, options: { ...withTarget.options, mode: 'merge' as const } };
    expect(codes(assessCopy(merge))).not.toContain('copy-timeseries-target');
  });

  it('lists views as skipped and leaves them out of the overlap check', () => {
    const findings = assessCopy(
      facts({
        sameServer: true,
        options: {
          sourceDatabase: 'shop',
          targetDatabase: 'shop',
          items: [{ source: 'v', target: 'v' }],
          mode: 'replace',
        },
        sourceNamespaces: [{ database: 'shop', collection: 'v', type: 'view' }],
      }),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        code: 'copy-skipped-namespaces',
        severity: 'info',
        detail: 'shop.v',
      }),
    ]);
  });
});
