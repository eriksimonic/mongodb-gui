import type { MongoClient } from 'mongodb';
import {
  type LogComponentVerbosity,
  type LogLine,
  type ServerLog,
  type ServerLogKind,
} from '@mongo-gui/core';
import {
  definedEntry,
  isPlainObject,
  readField,
  readNumber,
  readRecord,
  readString,
  readStringArray,
  type PlainObject,
} from '../documents';
import { runAdminCommand } from './command';

// Converts one getLog line. MongoDB 4.4 and newer write JSON lines with the keys t, s, c, id,
// ctx, msg and attr. Any other line, including older text lines, keeps only its raw text as the
// message. This function never throws.
export function parseLogLine(raw: string): LogLine {
  const json = parseJsonObject(raw);
  const message = readString(json, 'msg');
  if (json === undefined || message === undefined) {
    return { message: raw, raw };
  }
  return {
    ...definedEntry('ts', readTimestamp(json)),
    ...definedEntry('severity', readString(json, 's')),
    ...definedEntry('component', readString(json, 'c')),
    ...definedEntry('id', readNumber(json, 'id')),
    ...definedEntry('context', readString(json, 'ctx')),
    message,
    ...definedEntry('attributes', readField(json, 'attr')),
    raw,
  };
}

export async function getServerLog(client: MongoClient, kind: ServerLogKind): Promise<ServerLog> {
  const reply = await runAdminCommand(client, { getLog: kind });
  const lines = readStringArray(reply, 'log').map(parseLogLine);
  return {
    kind,
    total: readNumber(reply, 'totalLinesWritten') ?? lines.length,
    lines,
  };
}

// Verbosity per log component. Nested components get dotted names, such as "storage.recovery".
export async function getLogComponents(client: MongoClient): Promise<LogComponentVerbosity> {
  const reply = await runAdminCommand(client, { getParameter: 1, logComponentVerbosity: 1 });
  const tree = readRecord(reply, 'logComponentVerbosity') ?? {};
  const components: Record<string, number> = {};
  collectComponents('', tree, components);
  return { verbosity: readNumber(tree, 'verbosity') ?? 0, components };
}

function collectComponents(prefix: string, node: PlainObject, out: Record<string, number>): void {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'verbosity' || !isPlainObject(value)) {
      continue;
    }
    const name = prefix === '' ? key : `${prefix}.${key}`;
    const verbosity = readNumber(value, 'verbosity');
    if (verbosity !== undefined) {
      out[name] = verbosity;
    }
    collectComponents(name, value, out);
  }
}

function parseJsonObject(raw: string): PlainObject | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return isPlainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// Log timestamps are extended JSON dates, { "$date": "<ISO string>" }.
function readTimestamp(json: PlainObject): string | undefined {
  const value = json.t;
  if (typeof value === 'string') {
    return value;
  }
  return readString(value, '$date');
}
