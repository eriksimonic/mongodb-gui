import { BSON, type Db, type Document, type MongoClient } from 'mongodb';
import type { PlanVerbosity } from '@mongo-gui/core';
import { toCanonicalEjson } from '../ejson';

// Raw mode keeps the server's numbers as BSON wrappers, so the output is canonical EJSON, the
// same form the captured fixtures use.
const RAW_OPTIONS = { promoteValues: false, promoteLongs: false };

// Session fields that a captured command carries and an explain command must not repeat.
const SESSION_FIELDS: ReadonlySet<string> = new Set([
  'lsid',
  'txnNumber',
  'autocommit',
  'startTransaction',
]);

export interface ExplainCommandResult {
  // The explain document as canonical EJSON, already parsed to plain JSON.
  readonly raw: unknown;
  readonly elapsedMs: number;
}

// Parses a command captured as EJSON. Returns undefined when the text is not an EJSON object.
export function parseCommandEjson(text: string): Document | undefined {
  try {
    const parsed: unknown = BSON.EJSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Document)
      : undefined;
  } catch {
    return undefined;
  }
}

// Runs the explain command for a captured command on the database. The command runs with explain
// only, so a write command such as update reports its plan and changes nothing. Returns undefined
// when the command is not one the server can explain, such as getMore.
export async function runExplainCommand(
  client: MongoClient,
  options: {
    readonly database: string;
    readonly command: Document;
    readonly verbosity: PlanVerbosity;
  },
): Promise<ExplainCommandResult | undefined> {
  const inner = explainableCommand(options.command);
  if (inner === undefined) {
    return undefined;
  }
  const db: Db = client.db(options.database);
  const started = performance.now();
  const raw: unknown = await db.command(
    { explain: inner, verbosity: options.verbosity },
    RAW_OPTIONS,
  );
  return { raw: toCanonicalEjson(raw), elapsedMs: performance.now() - started };
}

// Drops driver session and transaction fields and the $-prefixed fields the server adds to a
// profiled command, such as $db and $clusterTime. Returns undefined for a command that cannot be
// explained.
export function explainableCommand(command: Document): Document | undefined {
  const names = Object.keys(command);
  const first = names[0];
  if (first === undefined || first === 'getMore' || first === 'explain') {
    return undefined;
  }
  const kept = Object.entries(command).filter(
    ([key]) => !key.startsWith('$') && !SESSION_FIELDS.has(key),
  );
  return Object.fromEntries(kept);
}
