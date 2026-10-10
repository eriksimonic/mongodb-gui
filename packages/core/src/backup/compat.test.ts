import { describe, expect, it } from 'vitest';
import {
  assessBackup,
  assessRestore,
  unresolvedFindings,
  type BackupFacts,
  type DumpFacts,
  type RestoreFacts,
} from './compat';
import type { Finding } from './findings';

function backupFacts(overrides: Partial<BackupFacts> = {}): BackupFacts {
  return {
    server: { serverVersion: '8.0.17', fcv: '8.0', topology: 'replicaSet' },
    namespaces: [{ database: 'shop', type: 'collection' }],
    tools: { selected: '100.19.1', installed: ['100.19.1'], available: ['100.19.1'] },
    ...overrides,
  };
}

function dump(overrides: Partial<DumpFacts> = {}): DumpFacts {
  return {
    sidecar: true,
    sidecarNewerFormat: false,
    serverVersion: '8.0.17',
    fcv: '8.0',
    toolsVersion: '100.19.1',
    namespaces: [{ database: 'shop', type: 'collection' }],
    ...overrides,
  };
}

function restoreFacts(overrides: Partial<RestoreFacts> = {}): RestoreFacts {
  return {
    dump: dump(),
    target: { serverVersion: '8.0.12', fcv: '8.0', topology: 'replicaSet' },
    tools: { selected: '100.19.1', installed: ['100.19.1'], available: ['100.19.1'] },
    options: { drop: false, oplogReplay: false, preserveUUID: false },
    ...overrides,
  };
}

function codes(findings: Finding[]): string[] {
  return findings.map((item) => item.code);
}

function only(findings: Finding[], code: string): Finding {
  const found = findings.find((item) => item.code === code);
  if (!found) throw new Error(`no ${code} in ${codes(findings).join(', ')}`);
  return found;
}

describe('assessBackup', () => {
  it('finds nothing for a matching setup', () => {
    expect(assessBackup(backupFacts())).toEqual([]);
  });

  it('blocks a server older than 4.2', () => {
    const findings = assessBackup(
      backupFacts({ server: { serverVersion: '4.0.28', topology: 'standalone' } }),
    );
    expect(only(findings, 'server-too-old')).toEqual({
      code: 'server-too-old',
      severity: 'block',
      confirmable: false,
      message: 'The tools cannot connect to MongoDB 4.0.28.',
    });
  });

  it('blocks time series on 9.0 with tools older than 100.16.0 and offers the newest', () => {
    const findings = assessBackup(
      backupFacts({
        server: { serverVersion: '9.0.1', topology: 'replicaSet' },
        namespaces: [{ database: 'iot', type: 'timeseries' }],
        tools: {
          selected: '100.12.1',
          installed: ['100.12.1', '100.16.0', '100.18.0'],
          available: [],
        },
      }),
    );
    const item = only(findings, 'timeseries-old-tools');
    expect(item.severity).toBe('block');
    expect(item.confirmable).toBe(false);
    expect(item.message).toBe('Time series collections on 9.0 need tools 100.16.0 or newer.');
    expect(item.action).toEqual({ kind: 'use-tools', version: '100.18.0' });
  });

  it('leaves time series alone below 9.0', () => {
    const findings = assessBackup(
      backupFacts({
        namespaces: [{ database: 'iot', type: 'timeseries' }],
        tools: { selected: '100.12.1', installed: ['100.12.1'], available: [] },
      }),
    );
    expect(codes(findings)).not.toContain('timeseries-old-tools');
  });

  it('warns when the tools predate the server and offers a download', () => {
    const findings = assessBackup(
      backupFacts({
        tools: { selected: '100.9.4', installed: ['100.9.4'], available: ['100.19.1', '100.10.0'] },
      }),
    );
    const item = only(findings, 'tools-too-old-for-server');
    expect(item.severity).toBe('warning');
    expect(item.message).toBe('Tools 100.9.4 predate MongoDB 8.0.17 support (added in 100.10.0).');
    expect(item.action).toEqual({ kind: 'download-tools', version: '100.19.1' });
  });

  it('warns past the end of the support table', () => {
    const findings = assessBackup(
      backupFacts({ server: { serverVersion: '9.1.0', topology: 'replicaSet' } }),
    );
    const item = only(findings, 'tools-too-old-for-server');
    expect(item.message).toBe('No tools release is known to support MongoDB 9.1.0 yet.');
    expect(item.action).toBeUndefined();
  });

  it('gives no action when no fitting version is installed or in the feed', () => {
    const findings = assessBackup(
      backupFacts({
        tools: { selected: '100.9.4', installed: ['100.9.4'], available: ['100.9.0'] },
      }),
    );
    expect(only(findings, 'tools-too-old-for-server').action).toBeUndefined();
  });

  it('marks encrypted collections strong', () => {
    const findings = assessBackup(
      backupFacts({ namespaces: [{ database: 'hr', type: 'collection', encrypted: true }] }),
    );
    const item = only(findings, 'encrypted-collections');
    expect(item.severity).toBe('strong');
    expect(item.message).toBe(
      'Queryable Encryption and CSFLE collections are not supported by mongodump.',
    );
  });

  it('warns about a sharded dump', () => {
    const findings = assessBackup(
      backupFacts({ server: { serverVersion: '8.0.17', topology: 'sharded' } }),
    );
    expect(only(findings, 'sharded-dump')).toMatchObject({
      severity: 'warning',
      message: 'Stop the balancer and DDL while the dump runs, or the dump may be inconsistent.',
    });
  });

  it('sorts by severity', () => {
    const findings = assessBackup(
      backupFacts({
        server: { serverVersion: '9.0.0', topology: 'sharded' },
        namespaces: [
          { database: 'iot', type: 'timeseries' },
          { database: 'hr', type: 'collection', encrypted: true },
        ],
        tools: { selected: '100.12.1', installed: ['100.12.1'], available: [] },
      }),
    );
    expect(codes(findings)).toEqual([
      'timeseries-old-tools',
      'encrypted-collections',
      'tools-too-old-for-server',
      'sharded-dump',
    ]);
  });
});

describe('assessRestore', () => {
  it('finds nothing for a matching setup', () => {
    expect(assessRestore(restoreFacts())).toEqual([]);
  });

  it('blocks a target older than 4.2', () => {
    const findings = assessRestore(
      restoreFacts({ target: { serverVersion: '4.0.1', topology: 'standalone' } }),
    );
    expect(only(findings, 'server-too-old')).toMatchObject({
      severity: 'block',
      confirmable: false,
    });
  });

  it('blocks a major.minor mismatch with differing FCVs, confirmably', () => {
    const findings = assessRestore(
      restoreFacts({ target: { serverVersion: '7.0.2', fcv: '7.0', topology: 'replicaSet' } }),
    );
    expect(only(findings, 'server-version-mismatch')).toEqual({
      code: 'server-version-mismatch',
      severity: 'block',
      confirmable: true,
      message: 'The backup comes from MongoDB 8.0.17 and the target runs 7.0.2.',
      detail: 'Feature compatibility versions: 8.0 and 7.0.',
    });
  });

  it('blocks a mismatch when an FCV is unknown', () => {
    const findings = assessRestore(
      restoreFacts({ target: { serverVersion: '8.2.0', topology: 'replicaSet' } }),
    );
    const item = only(findings, 'server-version-mismatch');
    expect(item.confirmable).toBe(true);
    expect(item.detail).toBe('The feature compatibility version of one side is unknown.');
  });

  it('warns for an older target with the same FCV', () => {
    const findings = assessRestore(
      restoreFacts({
        dump: dump({ serverVersion: '8.2.1', fcv: '8.0' }),
        target: { serverVersion: '8.0.12', fcv: '8.0', topology: 'replicaSet' },
      }),
    );
    expect(codes(findings)).toEqual(['target-older-fcv-match']);
    expect(findings[0]?.severity).toBe('warning');
  });

  it('warns for a newer target with the same FCV', () => {
    const findings = assessRestore(
      restoreFacts({ target: { serverVersion: '8.2.0', fcv: '8.0', topology: 'replicaSet' } }),
    );
    expect(codes(findings)).toEqual(['target-newer']);
    expect(findings[0]?.message).toBe(
      'Restoring into a newer server is not the supported upgrade path.',
    );
  });

  it('finds no server issue for the same major.minor with a different patch', () => {
    const findings = assessRestore(
      restoreFacts({ target: { serverVersion: '8.0.1', fcv: '7.0', topology: 'replicaSet' } }),
    );
    expect(findings).toEqual([]);
  });

  it('blocks oplog replay across 9.0', () => {
    const findings = assessRestore(
      restoreFacts({
        dump: dump({ serverVersion: '8.0.17', fcv: '8.0' }),
        target: { serverVersion: '9.0.1', fcv: '8.0', topology: 'replicaSet' },
        options: { drop: false, oplogReplay: true, preserveUUID: false },
      }),
    );
    expect(only(findings, 'oplog-timeseries-boundary')).toMatchObject({
      severity: 'block',
      confirmable: false,
    });
  });

  it('allows oplog replay on one side of 9.0', () => {
    const findings = assessRestore(
      restoreFacts({ options: { drop: false, oplogReplay: true, preserveUUID: false } }),
    );
    expect(findings).toEqual([]);
  });

  it('marks a tools major.minor mismatch strong and prefers the exact dump version', () => {
    const findings = assessRestore(
      restoreFacts({
        dump: dump({ toolsVersion: '100.12.1' }),
        tools: {
          selected: '100.19.1',
          installed: ['100.19.1', '100.12.2'],
          available: ['100.12.1'],
        },
      }),
    );
    const item = only(findings, 'tools-version-mismatch');
    expect(item.severity).toBe('strong');
    expect(item.message).toBe(
      'The backup was made with tools 100.12.1. Restoring with 100.19.1 may not work.',
    );
    // Installed comes first, so the installed patch beats the exact version in the feed.
    expect(item.action).toEqual({ kind: 'use-tools', version: '100.12.2' });
  });

  it('uses the exact dump tools version when it is installed', () => {
    const findings = assessRestore(
      restoreFacts({
        dump: dump({ toolsVersion: '100.12.1' }),
        tools: {
          selected: '100.19.1',
          installed: ['100.19.1', '100.12.2', '100.12.1'],
          available: [],
        },
      }),
    );
    expect(only(findings, 'tools-version-mismatch').action).toEqual({
      kind: 'use-tools',
      version: '100.12.1',
    });
  });

  it('downloads the exact version, else the newest with the same major.minor', () => {
    const exact = assessRestore(
      restoreFacts({
        dump: dump({ toolsVersion: '100.12.1' }),
        tools: {
          selected: '100.19.1',
          installed: ['100.19.1'],
          available: ['100.12.2', '100.12.1'],
        },
      }),
    );
    expect(only(exact, 'tools-version-mismatch').action).toEqual({
      kind: 'download-tools',
      version: '100.12.1',
    });
    const newest = assessRestore(
      restoreFacts({
        dump: dump({ toolsVersion: '100.12.0' }),
        tools: {
          selected: '100.19.1',
          installed: ['100.19.1'],
          available: ['100.12.1', '100.12.2', '100.13.0'],
        },
      }),
    );
    expect(only(newest, 'tools-version-mismatch').action).toEqual({
      kind: 'download-tools',
      version: '100.12.2',
    });
    const none = assessRestore(
      restoreFacts({
        dump: dump({ toolsVersion: '100.12.0' }),
        tools: { selected: '100.19.1', installed: ['100.19.1'], available: ['100.13.0'] },
      }),
    );
    expect(only(none, 'tools-version-mismatch').action).toBeUndefined();
  });

  it('notes a different tools patch', () => {
    const findings = assessRestore(restoreFacts({ dump: dump({ toolsVersion: '100.19.0' }) }));
    expect(codes(findings)).toEqual(['tools-patch-differs']);
    expect(findings[0]).toMatchObject({ severity: 'info', confirmable: false });
  });

  it('warns when the dump tools version is unknown', () => {
    const unknownTools = dump();
    delete unknownTools.toolsVersion;
    const findings = assessRestore(restoreFacts({ dump: unknownTools }));
    expect(only(findings, 'tools-version-unknown').severity).toBe('warning');
  });

  it('marks time series with old tools strong when either side is 9.0', () => {
    const findings = assessRestore(
      restoreFacts({
        dump: dump({
          serverVersion: '9.0.1',
          fcv: '9.0',
          toolsVersion: '100.15.0',
          namespaces: [{ database: 'iot', type: 'timeseries' }],
        }),
        target: { serverVersion: '9.0.2', fcv: '9.0', topology: 'replicaSet' },
        tools: {
          selected: '100.15.0',
          installed: ['100.15.0'],
          available: ['100.18.0', '100.16.0'],
        },
      }),
    );
    const item = only(findings, 'timeseries-old-tools');
    expect(item.severity).toBe('strong');
    expect(item.action).toEqual({ kind: 'download-tools', version: '100.18.0' });
  });

  it('marks encrypted namespaces strong', () => {
    const findings = assessRestore(
      restoreFacts({
        dump: dump({ namespaces: [{ database: 'hr', type: 'collection', encrypted: true }] }),
      }),
    );
    expect(only(findings, 'encrypted-collections').severity).toBe('strong');
  });

  it('marks preserveUUID or oplog replay on a sharded target strong', () => {
    const findings = assessRestore(
      restoreFacts({
        target: { serverVersion: '8.0.12', fcv: '8.0', topology: 'sharded' },
        options: { drop: false, oplogReplay: false, preserveUUID: true },
      }),
    );
    expect(only(findings, 'sharded-unsupported-option')).toMatchObject({
      severity: 'strong',
      message: 'A sharded cluster does not support preserve UUIDs.',
    });
  });

  it('warns when the target tools predate the target server', () => {
    const findings = assessRestore(
      restoreFacts({
        dump: dump({ toolsVersion: '100.9.4' }),
        tools: { selected: '100.9.4', installed: ['100.9.4', '100.10.0'], available: [] },
      }),
    );
    expect(only(findings, 'tools-too-old-for-server').action).toEqual({
      kind: 'use-tools',
      version: '100.10.0',
    });
  });

  it('warns when drop would replace the admin users', () => {
    const facts = restoreFacts({
      dump: dump({ namespaces: [{ database: 'admin', type: 'collection' }] }),
      options: { drop: true, oplogReplay: false, preserveUUID: false },
    });
    expect(only(assessRestore(facts), 'admin-drop').message).toBe(
      'Drop replaces every user on the target.',
    );
    const excluded = { ...facts, options: { ...facts.options, include: ['shop.*'] } };
    expect(codes(assessRestore(excluded))).not.toContain('admin-drop');
    const selected = { ...facts, options: { ...facts.options, include: ['admin.system.users'] } };
    expect(codes(assessRestore(selected))).toContain('admin-drop');
  });

  it('warns when only the prelude is known', () => {
    const findings = assessRestore(
      restoreFacts({
        dump: {
          sidecar: false,
          sidecarNewerFormat: false,
          serverVersion: '8.0.17',
          toolsVersion: '100.19.1',
          namespaces: [{ database: 'shop', type: 'collection' }],
        },
      }),
    );
    // No FCV, so the same major.minor is still fine.
    expect(codes(findings)).toEqual(['no-sidecar']);
    expect(findings[0]?.message).toBe(
      'Only the archive header is known. FCV, topology and options are not.',
    );
  });

  it('skips server checks when the prelude has no server version', () => {
    const findings = assessRestore(
      restoreFacts({
        dump: { sidecar: false, sidecarNewerFormat: false, namespaces: [] },
        target: { serverVersion: '7.0.2', topology: 'replicaSet' },
        options: { drop: false, oplogReplay: true, preserveUUID: false },
      }),
    );
    expect(codes(findings)).toEqual(['tools-version-unknown', 'no-sidecar']);
  });

  it('reports a newer sidecar format instead of a missing sidecar', () => {
    const findings = assessRestore(
      restoreFacts({ dump: dump({ sidecar: false, sidecarNewerFormat: true }) }),
    );
    expect(codes(findings)).toEqual(['sidecar-newer-format']);
  });

  it('sorts by severity', () => {
    const findings = assessRestore(
      restoreFacts({
        dump: dump({ sidecar: false, toolsVersion: '100.19.0' }),
        target: { serverVersion: '7.0.2', topology: 'sharded' },
        options: { drop: false, oplogReplay: false, preserveUUID: true },
      }),
    );
    expect(findings.map((item) => item.severity)).toEqual(['block', 'strong', 'warning', 'info']);
  });
});

describe('unresolvedFindings', () => {
  const hard: Finding = {
    code: 'server-too-old',
    severity: 'block',
    confirmable: false,
    message: 'a',
  };
  const confirmable: Finding = {
    code: 'server-version-mismatch',
    severity: 'block',
    confirmable: true,
    message: 'b',
  };
  const strong: Finding = {
    code: 'encrypted-collections',
    severity: 'strong',
    confirmable: false,
    message: 'c',
  };
  const warning: Finding = {
    code: 'sharded-dump',
    severity: 'warning',
    confirmable: false,
    message: 'd',
  };
  const info: Finding = {
    code: 'tools-patch-differs',
    severity: 'info',
    confirmable: false,
    message: 'e',
  };
  const all = [hard, confirmable, strong, warning, info];

  it('keeps every block and strong finding without input', () => {
    expect(unresolvedFindings(all, [], undefined, 'prod')).toEqual([hard, confirmable, strong]);
  });

  it('drops a confirmable block when the typed name matches', () => {
    expect(unresolvedFindings(all, [], 'prod', 'prod')).toEqual([hard, strong]);
    expect(unresolvedFindings(all, [], 'Prod', 'prod')).toEqual([hard, confirmable, strong]);
  });

  it('drops an acknowledged strong finding', () => {
    expect(unresolvedFindings(all, ['encrypted-collections'], undefined, 'prod')).toEqual([
      hard,
      confirmable,
    ]);
  });

  it('never drops a hard block', () => {
    expect(unresolvedFindings([hard], ['server-too-old'], 'prod', 'prod')).toEqual([hard]);
  });

  it('is empty for warnings and info only', () => {
    expect(unresolvedFindings([warning, info], [], undefined, 'prod')).toEqual([]);
  });
});
