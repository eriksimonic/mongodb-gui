import { describe, expect, it } from 'vitest';
import { FindingCodeSchema } from '../backup/findings';
import { assessCopy, type CopyFacts } from './assess';
import { unresolvedCopyFindings } from './start-checks';

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

  it('blocks merge into a time series target and leaves replace and insert only alone', () => {
    const withTarget = facts({
      targetNamespaces: [{ database: 'shop_copy', collection: 'orders', type: 'timeseries' }],
    });
    const merge = { ...withTarget, options: { ...withTarget.options, mode: 'merge' as const } };
    expect(assessCopy(merge)).toContainEqual(
      expect.objectContaining({ code: 'copy-timeseries-merge', severity: 'block' }),
    );
    const insertOnly = {
      ...withTarget,
      options: { ...withTarget.options, mode: 'insertOnly' as const },
    };
    expect(codes(assessCopy(insertOnly))).not.toContain('copy-timeseries-merge');
    expect(codes(assessCopy(withTarget))).not.toContain('copy-timeseries-merge');
  });

  it('blocks merge from a time series source', () => {
    const source = facts({
      sourceNamespaces: [{ database: 'shop', collection: 'orders', type: 'timeseries' }],
    });
    const merge = { ...source, options: { ...source.options, mode: 'merge' as const } };
    expect(assessCopy(merge)).toContainEqual(
      expect.objectContaining({ code: 'copy-timeseries-merge', severity: 'block' }),
    );
    expect(codes(assessCopy(source))).not.toContain('copy-timeseries-merge');
  });

  it('blocks insert only from a time series source into an existing plain collection', () => {
    const base = facts({
      sourceNamespaces: [{ database: 'shop', collection: 'orders', type: 'timeseries' }],
    });
    const insertOnly = { ...base, options: { ...base.options, mode: 'insertOnly' as const } };
    const plainTarget = {
      ...insertOnly,
      targetNamespaces: [
        { database: 'shop_copy', collection: 'orders', type: 'collection' as const },
      ],
    };
    expect(assessCopy(plainTarget)).toContainEqual(
      expect.objectContaining({ code: 'copy-timeseries-insert', severity: 'block' }),
    );
    expect(codes(assessCopy(insertOnly))).not.toContain('copy-timeseries-insert');
    const timeseriesTarget = {
      ...insertOnly,
      targetNamespaces: [
        { database: 'shop_copy', collection: 'orders', type: 'timeseries' as const },
      ],
    };
    expect(codes(assessCopy(timeseriesTarget))).not.toContain('copy-timeseries-insert');
  });

  it('blocks replace from a time series source into an existing plain collection', () => {
    const base = facts({
      sourceNamespaces: [{ database: 'shop', collection: 'orders', type: 'timeseries' }],
    });
    const plainTarget = {
      ...base,
      targetNamespaces: [
        { database: 'shop_copy', collection: 'orders', type: 'collection' as const },
      ],
    };
    expect(assessCopy(plainTarget)).toContainEqual(
      expect.objectContaining({ code: 'copy-timeseries-replace', severity: 'block' }),
    );
    expect(codes(assessCopy(base))).not.toContain('copy-timeseries-replace');
    const timeseriesTarget = {
      ...base,
      targetNamespaces: [
        { database: 'shop_copy', collection: 'orders', type: 'timeseries' as const },
      ],
    };
    expect(codes(assessCopy(timeseriesTarget))).not.toContain('copy-timeseries-replace');
    const insertOnly = {
      ...plainTarget,
      options: { ...plainTarget.options, mode: 'insertOnly' as const },
    };
    expect(codes(assessCopy(insertOnly))).not.toContain('copy-timeseries-replace');
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

const server = (serverVersion: string, fcv: string, topology = 'replicaSet') =>
  ({ serverVersion, fcv, topology }) as CopyFacts['source'];
const TIMESERIES = [{ database: 'shop', collection: 'orders', type: 'timeseries' as const }];
const ENCRYPTED = [
  { database: 'shop', collection: 'orders', type: 'collection' as const, encrypted: true },
];

interface Case {
  readonly name: string;
  /** The backup or restore code that the copy receives. */
  readonly code: string;
  /** The severity the copy shows for that code. */
  readonly expected: 'block' | 'strong' | 'warning';
  readonly facts: CopyFacts;
}

/** One case per backup or restore code that a copy can receive. */
const CASES: readonly Case[] = [
  {
    name: 'a source older than the tools support',
    code: 'server-too-old',
    expected: 'block',
    facts: facts({ source: server('4.0.28', '4.0') }),
  },
  {
    name: 'a target with another feature compatibility version',
    code: 'server-version-mismatch',
    expected: 'strong',
    facts: facts({ source: server('7.0.45', '7.0'), target: server('8.0.17', '8.0') }),
  },
  {
    name: 'a time series source on 9.0 with tools below 100.16',
    code: 'timeseries-old-tools',
    expected: 'block',
    facts: facts({
      source: server('9.0.0', '9.0'),
      target: server('9.0.0', '9.0'),
      tools: { selected: '100.15.0', installed: ['100.15.0'], available: [] },
      sourceNamespaces: TIMESERIES,
    }),
  },
  {
    name: 'a time series copy into a 9.0 target with tools below 100.16',
    code: 'timeseries-old-tools',
    expected: 'strong',
    facts: facts({
      source: server('8.0.17', '8.0'),
      target: server('9.0.0', '8.0'),
      tools: { selected: '100.15.0', installed: ['100.15.0', '100.19.1'], available: [] },
      sourceNamespaces: TIMESERIES,
    }),
  },
  {
    name: 'an encrypted collection',
    code: 'encrypted-collections',
    expected: 'strong',
    facts: facts({ sourceNamespaces: ENCRYPTED }),
  },
  {
    name: 'tools that predate the server while a newer install fits',
    code: 'tools-too-old-for-server',
    expected: 'warning',
    facts: facts({
      tools: { selected: '100.9.0', installed: ['100.9.0', '100.19.1'], available: [] },
    }),
  },
  {
    name: 'a newer target with the same feature compatibility version',
    code: 'target-newer',
    expected: 'warning',
    facts: facts({ source: server('7.0.45', '7.0'), target: server('8.0.17', '7.0') }),
  },
  {
    name: 'an older target with the same feature compatibility version',
    code: 'target-older-fcv-match',
    expected: 'warning',
    facts: facts({ source: server('8.0.17', '7.0'), target: server('7.0.45', '7.0') }),
  },
  {
    name: 'a sharded source',
    code: 'sharded-dump',
    expected: 'warning',
    facts: facts({ source: server('8.0.17', '8.0', 'sharded') }),
  },
];

// Codes that the backup or restore rules can produce, but that a copy never gets, because
// assessCopy fixes the dump and restore options (no drop, oplog replay, preserved UUIDs, sidecar).
const NEVER_RAISED_BY_COPY = [
  'oplog-timeseries-boundary',
  'tools-version-mismatch',
  'tools-patch-differs',
  'tools-version-unknown',
  'sharded-unsupported-option',
  'admin-drop',
  'no-sidecar',
  'sidecar-newer-format',
  'tools-not-installed',
];

describe('assessCopy with backup and restore findings', () => {
  it('lists every backup and restore code as a case or as never raised by a copy', () => {
    const reachable = new Set(CASES.map((item) => item.code));
    expect(NEVER_RAISED_BY_COPY.filter((code) => reachable.has(code))).toEqual([]);
    expect(new Set([...reachable, ...NEVER_RAISED_BY_COPY])).toEqual(
      new Set(FindingCodeSchema.options),
    );
  });

  it.each(CASES)('$name shows $code as $expected', ({ code, expected, facts: input }) => {
    const found = assessCopy(input).filter((item) => item.code === code);
    expect(found.map((item) => item.severity)).toEqual([expected]);
    for (const item of found) {
      expect(item.confirmable).toBe(false);
      expect(item.message).not.toMatch(/backup|restor/i);
    }
    // A block stops the copy even when acknowledged. A strong finding stops it until acknowledged.
    expect(unresolvedCopyFindings(found, [code])).toEqual(expected === 'block' ? found : []);
    expect(unresolvedCopyFindings(found, []).length).toBe(
      expected === 'warning' ? 0 : found.length,
    );
  });

  it('never gives a copy a finding that asks for a typed connection name', () => {
    for (const item of CASES) {
      for (const finding of assessCopy(item.facts)) {
        expect(finding.confirmable, `${finding.code} in ${item.name}`).toBe(false);
      }
    }
  });

  it('words the version notice for a copy and keeps the versions in the detail', () => {
    const findings = assessCopy(CASES[1]?.facts as CopyFacts);
    expect(findings).toEqual([
      {
        code: 'server-version-mismatch',
        severity: 'strong',
        confirmable: false,
        message: 'This copy goes from MongoDB 7.0.45 to 8.0.17. Some features may not carry over.',
        detail: 'Feature compatibility versions: 7.0 and 8.0.',
      },
    ]);
  });
});
