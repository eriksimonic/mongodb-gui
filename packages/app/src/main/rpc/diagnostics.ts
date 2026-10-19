import {
  AppErrorException,
  appError,
  capDiagnosticText,
  isSecretKey,
  redactArgv,
  redactDiagnosticRecord,
  redactDiagnosticValue,
  redactRawLine,
  redactUriText,
  rpcContract,
  type LogLine,
  type RpcEvent,
  type ServerLog,
  type ServerParameter,
} from '@mongo-gui/core';
import {
  getBuildInfo,
  getCollStats,
  getCommandLineOptions,
  getConnPoolStats,
  getDbStats,
  getHostInfo,
  getParameters,
  getServerLog,
  getServerStatusTree,
  getStorageCollections,
  getStorageDatabases,
  getTop,
  killAllSessionsByUser,
  killSessions,
  listSessions,
  serverStatusDocument,
  setParameter,
  toCanonicalEjson,
} from '@mongo-gui/mongo-adapter';
import { connectionCalls, type Operation } from './operation';

/** The client a diagnostics call runs against. */
type DiagnosticsClient = Parameters<typeof getServerLog>[0];

/** What the diagnostics calls need from the router. */
export interface DiagnosticsDeps {
  readonly getClient: (connectionId: string) => DiagnosticsClient;
  readonly emit: (event: RpcEvent) => void;
}

/**
 * Server logs, parameters, host and build facts, sessions and the other diagnostics. Secret fields
 * are masked and URIs redacted before a reply leaves. The kill calls report no catalog change.
 */
export function diagnosticsOperations(deps: DiagnosticsDeps): [string, Operation][] {
  const { readOnly } = connectionCalls(deps.getClient, deps.emit);
  const d = rpcContract.diagnostics;
  return [
    readOnly('diagnostics.getLog', d.getLog, async (client, input) =>
      redactLog(await getServerLog(client, input.kind)),
    ),
    readOnly('diagnostics.cmdLineOpts', d.cmdLineOpts, async (client) => {
      const options = await getCommandLineOptions(client);
      return {
        argv: redactArgv(options.argv),
        parsed: toCanonicalEjson(redactDiagnosticValue(options.parsed)),
      };
    }),
    readOnly('diagnostics.parameters', d.parameters, async (client) =>
      (await getParameters(client)).map(redactParameter),
    ),
    readOnly('diagnostics.setParameter', d.setParameter, (client, input) => {
      // The panel shows a masked value for these, so a change would be blind.
      if (isSecretKey(input.name)) {
        throw new AppErrorException(
          appError('VALIDATION', `${input.name} holds a secret and cannot be changed here`),
        );
      }
      return setParameter(client, input.name, input.value);
    }),
    readOnly('diagnostics.hostInfo', d.hostInfo, (client) => getHostInfo(client)),
    readOnly('diagnostics.buildInfo', d.buildInfo, (client) => getBuildInfo(client)),
    readOnly('diagnostics.serverStatus', d.serverStatus, async (client) => {
      const tree = await getServerStatusTree(client);
      return {
        at: tree.at,
        stripped: tree.stripped,
        document: redactDiagnosticRecord(serverStatusDocument(tree)),
      };
    }),
    readOnly('diagnostics.top', d.top, (client) => getTop(client)),
    readOnly('diagnostics.dbStats', d.dbStats, (client, input) =>
      getDbStats(client, input.database),
    ),
    readOnly('diagnostics.collStats', d.collStats, (client, input) =>
      getCollStats(client, input.database, input.collection),
    ),
    readOnly('diagnostics.storageDatabases', d.storageDatabases, (client) =>
      getStorageDatabases(client),
    ),
    readOnly('diagnostics.storageCollections', d.storageCollections, (client, input) =>
      getStorageCollections(client, input.database),
    ),
    readOnly('diagnostics.connPoolStats', d.connPoolStats, (client) => getConnPoolStats(client)),
    readOnly('diagnostics.listSessions', d.listSessions, (client, input) =>
      listSessions(client, { allUsers: input.allUsers === true }),
    ),
    readOnly('diagnostics.killSessions', d.killSessions, (client, input) =>
      killSessions(client, input.ids),
    ),
    readOnly('diagnostics.killAllSessionsByUser', d.killAllSessionsByUser, (client, input) =>
      killAllSessionsByUser(client, input.users),
    ),
  ];
}

/** The text the log viewer shows: secrets masked, URIs redacted, attributes in canonical EJSON. */
function redactLog(log: ServerLog): ServerLog {
  return { ...log, lines: log.lines.map(redactLogLine) };
}

function redactLogLine(line: LogLine): LogLine {
  const { attributes, ...rest } = line;
  return {
    ...rest,
    message: redactUriText(line.message),
    raw: redactRawLine(line.raw),
    ...(attributes === undefined
      ? {}
      : { attributes: toCanonicalEjson(redactDiagnosticValue(attributes)) }),
  };
}

const PARAMETER_MASK = '***';

/**
 * A parameter with secrets masked. Strings and object or array values are redacted recursively,
 * and a structured value longer than the cap is cut short with truncated set.
 */
function redactParameter(parameter: ServerParameter): ServerParameter {
  if (isSecretKey(parameter.name)) {
    return {
      name: parameter.name,
      value: PARAMETER_MASK,
      valueEjson: JSON.stringify(PARAMETER_MASK),
    };
  }
  if (parameter.value !== undefined) {
    if (typeof parameter.value !== 'string') {
      return parameter;
    }
    const value = redactUriText(parameter.value);
    return { name: parameter.name, value, valueEjson: JSON.stringify(value) };
  }
  // An object or array has no scalar value. Its canonical text is redacted as a parsed document.
  let redacted: unknown;
  try {
    redacted = redactDiagnosticValue(JSON.parse(parameter.valueEjson) as unknown);
  } catch {
    const text = capDiagnosticText(redactUriText(parameter.valueEjson));
    return {
      name: parameter.name,
      value: text.text,
      valueEjson: text.text,
      truncated: text.truncated,
    };
  }
  const text = capDiagnosticText(JSON.stringify(redacted));
  if (text.truncated) {
    return { name: parameter.name, value: text.text, valueEjson: text.text, truncated: true };
  }
  return { name: parameter.name, value: redacted, valueEjson: text.text };
}
