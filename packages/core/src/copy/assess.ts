import { z } from 'zod';
import {
  assessBackup,
  assessRestore,
  type CompatNamespace,
  type CompatServer,
  type CompatTools,
  type DumpFacts,
} from '../backup/compat';
import {
  FindingCodeSchema,
  FindingSchema,
  type Finding,
  type FindingCode,
  type FindingSeverity,
} from '../backup/findings';
import { compareVersions, firstToolsFor } from '../backup/versions';
import type { CopyItem, CopyOptions } from './options';

// Codes that only a copy raises. They extend the shared backup codes in backup/findings.ts.
export const CopyFindingCodeSchema = z.enum([
  ...FindingCodeSchema.options,
  'copy-overlap',
  'copy-timeseries-rename',
  'copy-timeseries-target',
  'copy-timeseries-merge',
  'copy-timeseries-insert',
  'copy-timeseries-replace',
  'copy-skipped-namespaces',
]);
export const CopyFindingSchema = FindingSchema.extend({ code: CopyFindingCodeSchema });

export type CopyFindingCode = z.infer<typeof CopyFindingCodeSchema>;
export type CopyFinding = z.infer<typeof CopyFindingSchema>;
export type CopyNamespace = CompatNamespace & { readonly collection: string };

export interface CopyFacts {
  readonly source: CompatServer;
  readonly target: CompatServer;
  readonly tools: CompatTools;
  // From sameServer() in server-identity.ts.
  readonly sameServer: boolean;
  readonly options: Pick<CopyOptions, 'sourceDatabase' | 'targetDatabase' | 'items' | 'mode'>;
  // The source collections the items name, with their type and encryption.
  readonly sourceNamespaces: readonly CopyNamespace[];
  // The collections in the target database now.
  readonly targetNamespaces: readonly CopyNamespace[];
}

// The first tools release that handles a time series rename.
const TIMESERIES_TOOLS = '100.16.0';
const SEVERITY_ORDER: readonly FindingSeverity[] = ['block', 'strong', 'warning', 'info'];

const key = (database: string, collection: string): string => `${database}.${collection}`;

// Copy wording for the backup and restore findings that a copy can receive. The codes stay the same.
const COPY_MESSAGE: Partial<Record<FindingCode, (facts: CopyFacts) => string>> = {
  'server-version-mismatch': (facts) =>
    `This copy goes from MongoDB ${facts.source.serverVersion} to ${facts.target.serverVersion}. Some features may not carry over.`,
  'target-newer': () => 'Copying to a newer server is not the supported upgrade path.',
};

/**
 * A backup or restore finding as a copy shows it. A confirmable block asks for a typed connection
 * name, which a copy does not offer, so it becomes a strong finding that `acknowledged` resolves.
 */
function forCopy(item: Finding, facts: CopyFacts): CopyFinding {
  const severity: FindingSeverity =
    item.severity === 'block' && item.confirmable ? 'strong' : item.severity;
  return {
    code: item.code,
    severity,
    confirmable: false,
    message: COPY_MESSAGE[item.code]?.(facts) ?? item.message,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
  };
}

function finding(
  code: CopyFindingCode,
  severity: FindingSeverity,
  message: string,
  detail?: string,
): CopyFinding {
  return {
    code,
    severity,
    confirmable: false,
    message,
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * The findings for a copy. The backup checks run on the source, and the restore checks run on
 * the target with the source as the dump. The tools version has to fit both servers.
 */
export function assessCopy(facts: CopyFacts): CopyFinding[] {
  const { source, target, tools, options, sameServer } = facts;
  const { sourceDatabase, targetDatabase } = options;
  const types = new Map(
    facts.sourceNamespaces.map((ns): [string, string] => [
      key(ns.database, ns.collection),
      ns.type,
    ]),
  );
  const isView = (item: CopyItem) => types.get(key(sourceDatabase, item.source)) === 'view';
  // Views are not copied, so they stay out of the checks and the writes.
  const copied = facts.sourceNamespaces.filter((ns) => ns.type !== 'view');
  const items = options.items.filter((item) => !isView(item));

  const dump: DumpFacts = {
    sidecar: true,
    sidecarNewerFormat: false,
    serverVersion: source.serverVersion,
    ...(source.fcv === undefined ? {} : { fcv: source.fcv }),
    toolsVersion: tools.selected,
    namespaces: copied,
  };
  const findings: CopyFinding[] = [
    ...assessBackup({ server: source, namespaces: copied, tools }).map((item) =>
      forCopy(item, facts),
    ),
    ...assessRestore({
      dump,
      target,
      tools,
      options: { include: undefined, drop: false, oplogReplay: false, preserveUUID: false },
    }).map((item) => forCopy(item, facts)),
  ];

  const minimums = [source, target]
    .map((server) => firstToolsFor(server.serverVersion)?.tools)
    .filter((version): version is string => version !== undefined);
  const fitsBoth = (version: string) =>
    minimums.every((minimum) => compareVersions(version, minimum) >= 0);
  if (!fitsBoth(tools.selected) && ![...tools.installed, ...tools.available].some(fitsBoth)) {
    findings.push(
      finding(
        'tools-too-old-for-server',
        'block',
        'No installed or downloadable tools version works with both servers.',
      ),
    );
  }

  const reads = new Set(items.map((item) => key(sourceDatabase, item.source)));
  if (sameServer) {
    const clashes = items.filter((item) => reads.has(key(targetDatabase, item.target)));
    if (clashes.length > 0) {
      findings.push(
        finding(
          'copy-overlap',
          'block',
          'The copy writes to a collection it also reads, on the same server.',
          clashes.map((item) => key(targetDatabase, item.target)).join(', '),
        ),
      );
    }
  }

  const renamed = items.filter(
    (item) =>
      types.get(key(sourceDatabase, item.source)) === 'timeseries' &&
      (item.target !== item.source || targetDatabase !== sourceDatabase),
  );
  if (renamed.length > 0 && compareVersions(tools.selected, TIMESERIES_TOOLS) < 0) {
    findings.push(
      finding(
        'copy-timeseries-rename',
        'warning',
        `Tools ${tools.selected} may fail to rename a time series collection. Renaming needs ${TIMESERIES_TOOLS} or newer.`,
        renamed.map((item) => key(sourceDatabase, item.source)).join(', '),
      ),
    );
  }

  const timeseriesTargets = items.filter((item) =>
    facts.targetNamespaces.some(
      (ns) =>
        ns.type === 'timeseries' &&
        key(ns.database, ns.collection) === key(targetDatabase, item.target),
    ),
  );
  // A time series source is read as its buckets, so merge would copy bucket documents as data.
  const timeseriesSources = items.filter(
    (item) => types.get(key(sourceDatabase, item.source)) === 'timeseries',
  );
  if (options.mode === 'merge' && (timeseriesTargets.length > 0 || timeseriesSources.length > 0)) {
    findings.push(
      finding(
        'copy-timeseries-merge',
        'block',
        'Merge cannot copy time series collections. Use replace or insert only.',
        [
          ...timeseriesSources.map((item) => key(sourceDatabase, item.source)),
          ...timeseriesTargets.map((item) => key(targetDatabase, item.target)),
        ].join(', '),
      ),
    );
  }
  // A time series source is restored as its buckets. An existing plain collection cannot take
  // them, and replace drops only the buckets, so the plain collection would stay.
  const plainTargets = timeseriesSources.filter((item) =>
    facts.targetNamespaces.some(
      (ns) =>
        ns.type === 'collection' &&
        key(ns.database, ns.collection) === key(targetDatabase, item.target),
    ),
  );
  const plainNames = plainTargets.map((item) => key(targetDatabase, item.target)).join(', ');
  if (options.mode === 'insertOnly' && plainTargets.length > 0) {
    findings.push(
      finding(
        'copy-timeseries-insert',
        'block',
        'Insert only cannot add time series data to a collection that is not time series. Use replace.',
        plainNames,
      ),
    );
  }
  if (options.mode === 'replace' && plainTargets.length > 0) {
    findings.push(
      finding(
        'copy-timeseries-replace',
        'block',
        'Replace cannot write a time series source over a collection that is not time series. Drop the target first.',
        plainNames,
      ),
    );
  }
  if (timeseriesTargets.length > 0 && options.mode === 'replace') {
    findings.push(
      finding(
        'copy-timeseries-target',
        'warning',
        'Replace drops and refills a time series collection in place. A cancel leaves it partly filled.',
        timeseriesTargets.map((item) => key(targetDatabase, item.target)).join(', '),
      ),
    );
  }

  const views = options.items.filter(isView);
  if (views.length > 0) {
    findings.push(
      finding(
        'copy-skipped-namespaces',
        'info',
        'Views are not copied.',
        views.map((item) => key(sourceDatabase, item.source)).join(', '),
      ),
    );
  }

  // The backup and restore checks can raise the same finding twice. Keep the first of each.
  const seen = new Set<string>();
  const unique = findings.filter((item) => {
    const id = `${item.code}\n${item.message}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return unique.sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
}
