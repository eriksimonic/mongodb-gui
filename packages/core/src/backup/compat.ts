import type { Finding, FindingAction, FindingCode, FindingSeverity } from './findings';
import type { RestoreOptions } from './options';
import type { BackupNamespaceInfo, BackupServerInfo } from './server-info';
import { compareVersions, firstToolsFor, majorMinor } from './versions';

export type CompatServer = Pick<BackupServerInfo, 'serverVersion' | 'fcv' | 'topology'>;
export type CompatNamespace = Pick<BackupNamespaceInfo, 'database' | 'type' | 'encrypted'>;

export interface CompatTools {
  selected: string;
  installed: readonly string[];
  // Versions in MongoDB's download feed for this platform.
  available: readonly string[];
}

export interface BackupFacts {
  server: CompatServer;
  // The namespaces in the backup scope.
  namespaces: readonly CompatNamespace[];
  tools: CompatTools;
}

// What is known about a dump. A valid sidecar gives every field; without one the archive
// prelude may give the server and tools versions only.
export interface DumpFacts {
  sidecar: boolean;
  // The sidecar header has a format version this app does not read.
  sidecarNewerFormat: boolean;
  serverVersion?: string;
  fcv?: string;
  toolsVersion?: string;
  namespaces: readonly CompatNamespace[];
}

export interface RestoreFacts {
  dump: DumpFacts;
  target: CompatServer;
  tools: CompatTools;
  options: Pick<RestoreOptions, 'include' | 'drop' | 'oplogReplay' | 'preserveUUID'>;
}

const MIN_SERVER = '4.2';
const TIMESERIES_TOOLS = '100.16.0';
const TIMESERIES_SERVER = '9.0';
const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  block: 0,
  strong: 1,
  warning: 2,
  info: 3,
};

const ENCRYPTED_MESSAGE =
  'Queryable Encryption and CSFLE collections are not supported by mongodump.';
const TIMESERIES_MESSAGE = 'Time series collections on 9.0 need tools 100.16.0 or newer.';

function finding(
  code: FindingCode,
  severity: FindingSeverity,
  message: string,
  extra: { confirmable?: boolean; detail?: string; action?: FindingAction | undefined } = {},
): Finding {
  const { confirmable = false, detail, action } = extra;
  return {
    code,
    severity,
    confirmable,
    message,
    ...(detail === undefined ? {} : { detail }),
    ...(action === undefined ? {} : { action }),
  };
}

function bySeverity(findings: Finding[]): Finding[] {
  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function isBelow(version: string | undefined, limit: string): boolean {
  return (
    version !== undefined &&
    majorMinor(version) !== undefined &&
    compareVersions(version, limit) < 0
  );
}

function isAtLeast(version: string | undefined, limit: string): boolean {
  return (
    version !== undefined &&
    majorMinor(version) !== undefined &&
    compareVersions(version, limit) >= 0
  );
}

function newest(versions: readonly string[]): string | undefined {
  return [...versions].sort(compareVersions).at(-1);
}

// An installed version that fits gives use-tools, else one in the feed gives download-tools.
// A preferred version wins over the newest fitting one in each list.
function toolsAction(
  tools: CompatTools,
  fits: (version: string) => boolean,
  preferred?: string,
): FindingAction | undefined {
  const pick = (list: readonly string[]) =>
    preferred !== undefined && list.includes(preferred) ? preferred : newest(list.filter(fits));
  const installed = pick(tools.installed);
  if (installed !== undefined) return { kind: 'use-tools', version: installed };
  const available = pick(tools.available);
  if (available !== undefined) return { kind: 'download-tools', version: available };
  return undefined;
}

function serverTooOld(server: CompatServer): Finding | undefined {
  if (!isBelow(server.serverVersion, MIN_SERVER)) return undefined;
  return finding(
    'server-too-old',
    'block',
    `The tools cannot connect to MongoDB ${server.serverVersion}.`,
  );
}

function toolsTooOld(server: CompatServer, tools: CompatTools): Finding | undefined {
  const support = firstToolsFor(server.serverVersion);
  if (!support) return undefined;
  const fits = (version: string) => compareVersions(version, support.tools) >= 0;
  const tooOld = !fits(tools.selected);
  if (!support.beyondTable && !tooOld) return undefined;
  const action = tooOld ? toolsAction(tools, fits) : undefined;
  const message = support.beyondTable
    ? `No tools release is known to support MongoDB ${server.serverVersion} yet.`
    : `Tools ${tools.selected} predate MongoDB ${server.serverVersion} support (added in ${support.tools}).`;
  return finding('tools-too-old-for-server', 'warning', message, { action });
}

function timeseriesTools(tools: CompatTools): FindingAction | undefined {
  return toolsAction(tools, (version) => compareVersions(version, TIMESERIES_TOOLS) >= 0);
}

export function assessBackup(facts: BackupFacts): Finding[] {
  const { server, namespaces, tools } = facts;
  const findings: Finding[] = [];
  const add = (item: Finding | undefined) => {
    if (item) findings.push(item);
  };

  add(serverTooOld(server));
  if (
    namespaces.some((ns) => ns.type === 'timeseries') &&
    isAtLeast(server.serverVersion, TIMESERIES_SERVER) &&
    isBelow(tools.selected, TIMESERIES_TOOLS)
  ) {
    add(
      finding('timeseries-old-tools', 'block', TIMESERIES_MESSAGE, {
        action: timeseriesTools(tools),
      }),
    );
  }
  add(toolsTooOld(server, tools));
  if (namespaces.some((ns) => ns.encrypted)) {
    add(finding('encrypted-collections', 'strong', ENCRYPTED_MESSAGE));
  }
  if (server.topology === 'sharded') {
    add(
      finding(
        'sharded-dump',
        'warning',
        'Stop the balancer and DDL while the dump runs, or the dump may be inconsistent.',
      ),
    );
  }
  return bySeverity(findings);
}

function sameFcv(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const left = majorMinor(a);
  return left !== undefined && left === majorMinor(b);
}

function serverFindings(dump: DumpFacts, target: CompatServer): Finding[] {
  const source = dump.serverVersion;
  const sourceMm = source === undefined ? undefined : majorMinor(source);
  const targetMm = majorMinor(target.serverVersion);
  if (source === undefined || sourceMm === undefined || targetMm === undefined) return [];
  if (sourceMm === targetMm) return [];
  if (!sameFcv(dump.fcv, target.fcv)) {
    const detail =
      dump.fcv === undefined || target.fcv === undefined
        ? 'The feature compatibility version of one side is unknown.'
        : `Feature compatibility versions: ${dump.fcv} and ${target.fcv}.`;
    return [
      finding(
        'server-version-mismatch',
        'block',
        `The backup comes from MongoDB ${source} and the target runs ${target.serverVersion}.`,
        { confirmable: true, detail },
      ),
    ];
  }
  if (compareVersions(target.serverVersion, source) < 0) {
    return [
      finding(
        'target-older-fcv-match',
        'warning',
        `The target runs an older MongoDB (${target.serverVersion}) than the source (${source}). Both use feature compatibility version ${target.fcv}.`,
      ),
    ];
  }
  return [
    finding(
      'target-newer',
      'warning',
      'Restoring into a newer server is not the supported upgrade path.',
    ),
  ];
}

function toolsVersionFindings(dump: DumpFacts, tools: CompatTools): Finding | undefined {
  const dumped = dump.toolsVersion;
  if (dumped === undefined || majorMinor(dumped) === undefined) {
    return finding(
      'tools-version-unknown',
      'warning',
      'The tools version that made this backup is unknown.',
    );
  }
  const dumpedMm = majorMinor(dumped);
  if (dumpedMm !== majorMinor(tools.selected)) {
    const action = toolsAction(tools, (version) => majorMinor(version) === dumpedMm, dumped);
    return finding(
      'tools-version-mismatch',
      'strong',
      `The backup was made with tools ${dumped}. Restoring with ${tools.selected} may not work.`,
      { action },
    );
  }
  if (compareVersions(dumped, tools.selected) !== 0) {
    return finding(
      'tools-patch-differs',
      'info',
      `The backup was made with tools ${dumped}. You selected ${tools.selected}.`,
    );
  }
  return undefined;
}

function includesDatabase(include: readonly string[] | undefined, database: string): boolean {
  return include === undefined || include.some((selector) => selector.startsWith(`${database}.`));
}

export function assessRestore(facts: RestoreFacts): Finding[] {
  const { dump, target, tools, options } = facts;
  const findings: Finding[] = [];
  const add = (item: Finding | undefined) => {
    if (item) findings.push(item);
  };

  add(serverTooOld(target));
  findings.push(...serverFindings(dump, target));

  const sourceNew = isAtLeast(dump.serverVersion, TIMESERIES_SERVER);
  const targetNew = isAtLeast(target.serverVersion, TIMESERIES_SERVER);
  const sourceOld = isBelow(dump.serverVersion, TIMESERIES_SERVER);
  const targetOld = isBelow(target.serverVersion, TIMESERIES_SERVER);
  if (options.oplogReplay && ((sourceOld && targetNew) || (sourceNew && targetOld))) {
    add(
      finding(
        'oplog-timeseries-boundary',
        'block',
        `Oplog replay cannot cross MongoDB 9.0 (${dump.serverVersion} to ${target.serverVersion}).`,
      ),
    );
  }

  add(toolsVersionFindings(dump, tools));

  if (
    dump.namespaces.some((ns) => ns.type === 'timeseries') &&
    (sourceNew || targetNew) &&
    isBelow(tools.selected, TIMESERIES_TOOLS)
  ) {
    add(
      finding('timeseries-old-tools', 'strong', TIMESERIES_MESSAGE, {
        action: timeseriesTools(tools),
      }),
    );
  }
  if (dump.namespaces.some((ns) => ns.encrypted)) {
    add(finding('encrypted-collections', 'strong', ENCRYPTED_MESSAGE));
  }
  if (target.topology === 'sharded' && (options.preserveUUID || options.oplogReplay)) {
    const names = [options.preserveUUID && 'preserve UUIDs', options.oplogReplay && 'oplog replay']
      .filter(Boolean)
      .join(' and ');
    add(
      finding(
        'sharded-unsupported-option',
        'strong',
        `A sharded cluster does not support ${names}.`,
      ),
    );
  }
  add(toolsTooOld(target, tools));
  if (
    options.drop &&
    dump.namespaces.some((ns) => ns.database === 'admin') &&
    includesDatabase(options.include, 'admin')
  ) {
    add(finding('admin-drop', 'warning', 'Drop replaces every user on the target.'));
  }
  if (dump.sidecarNewerFormat) {
    add(
      finding(
        'sidecar-newer-format',
        'warning',
        'A newer Mongo GUI made this backup. Only the archive header is read.',
      ),
    );
  } else if (!dump.sidecar) {
    add(
      finding(
        'no-sidecar',
        'warning',
        'Only the archive header is known. FCV, topology and options are not.',
      ),
    );
  }
  return bySeverity(findings);
}

// The findings that still stop a start: hard blocks, confirmable blocks without the typed
// connection name, and strong warnings that are not acknowledged.
export function unresolvedFindings(
  findings: readonly Finding[],
  acknowledged: readonly FindingCode[],
  confirmation: string | undefined,
  connectionName: string,
): Finding[] {
  return findings.filter((item) => {
    if (item.severity === 'block') return !item.confirmable || confirmation !== connectionName;
    if (item.severity === 'strong') return !acknowledged.includes(item.code);
    return false;
  });
}
