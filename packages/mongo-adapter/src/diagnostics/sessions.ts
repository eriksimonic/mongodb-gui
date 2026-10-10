import { Binary, MongoServerError, type Document, type MongoClient } from 'mongodb';
import type { SessionFallbackReason, SessionInfo, SessionList } from '@mongo-gui/core';
import {
  definedEntry,
  readBoolean,
  readDate,
  readField,
  readRecord,
  readString,
} from '../documents';
import { toAppException, validationError } from '../management/errors';
import { runAdminCommand } from './command';

export interface SessionUser {
  readonly user: string;
  readonly db: string;
}

export interface ListSessionsOptions {
  readonly allUsers?: boolean;
  readonly users?: readonly SessionUser[];
}

const SESSION_ID_HEX = /^[0-9a-f]{32}$/i;
const UNAUTHORIZED_CODE = 13;
const COMMAND_NOT_FOUND_CODE = 59;
const NAMESPACE_NOT_FOUND_CODE = 26;

// Lists sessions cluster-wide from config.system.sessions when the caller asks for other users.
// The "all" scope is reported whenever that read succeeds, even when it returns no rows. When the
// server refuses the read as unauthorized, or reports that the command or namespace does not exist,
// the list falls back to the local sessions, reports the scope as "local", and names the reason in
// fallbackReason. Any other failure is thrown to the caller.
//
// Rows from config.system.sessions carry only the user digest (_id.uid). The user name is filled
// by matching that digest against the local listing. A digest with no local match keeps only
// userId, the sole identity for that session.
export async function listSessions(
  client: MongoClient,
  options: ListSessionsOptions = {},
): Promise<SessionList> {
  const filter = sessionFilter(options);
  if (options.allUsers === true || (options.users?.length ?? 0) > 0) {
    const global = await readGlobalRows(client, filter);
    if (global.ok) {
      const names = await userNamesByDigest(client);
      return {
        scope: 'all',
        sessions: global.rows.flatMap((row) => toSessionInfo(row, names)),
      };
    }
    // A caller without the listSessions privilege still sees its own sessions. Asking for other
    // users would fail again, so the local read drops that filter.
    const ownFilter = global.reason === 'unauthorized' ? {} : filter;
    const rows = await readLocalRows(client, ownFilter);
    return {
      scope: 'local',
      sessions: rows.flatMap((row) => toSessionInfo(row)),
      fallbackReason: global.reason,
    };
  }
  const rows = await readLocalRows(client, filter);
  return {
    scope: 'local',
    sessions: rows.flatMap((row) => toSessionInfo(row)),
  };
}

// The ids are the lsid UUIDs as 32 hex characters, as listSessions returns them. The server
// interrupts the session's running operations. An operation that later reuses the same lsid
// starts a new session, so the kill does not block that lsid for good (seen on 4.4, 6.0, 8.0).
export async function killSessions(client: MongoClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) {
    throw validationError('Choose at least one session to kill');
  }
  const sessions = ids.map((id) => ({ id: toUuidBinary(id) }));
  await runAdminCommand(client, { killSessions: sessions });
}

// Kills the running operations and sessions of each user.
//
// The caller needs the impersonate privilege on the cluster, in addition to killAnySession. The
// root role lacks impersonate, so a root client gets "Not authorized to impersonate".
//
// Side effect: on 4.4, 6.0 and 8.0 a run of this command also interrupted a running read from a
// different user (root) in the same test, not only the target user's read. Callers should expect
// running operations outside the named users to be interrupted.
export async function killAllSessionsByUser(
  client: MongoClient,
  users: readonly SessionUser[],
): Promise<void> {
  if (users.length === 0) {
    throw validationError('Choose at least one user whose sessions to kill');
  }
  // Each pattern matches the sessions of one user. Patterns combine with OR on the server.
  const patterns = users.map((user) => ({ users: [sessionUser(user)] }));
  await runAdminCommand(client, { killAllSessionsByPattern: patterns });
}

type GlobalRows =
  | { readonly ok: true; readonly rows: unknown[] }
  | { readonly ok: false; readonly reason: SessionFallbackReason };

async function readGlobalRows(client: MongoClient, filter: Document): Promise<GlobalRows> {
  try {
    const rows: unknown[] = await client
      .db('config')
      .collection('system.sessions')
      .aggregate([{ $listSessions: filter }])
      .toArray();
    return { ok: true, rows };
  } catch (error) {
    const reason = fallbackReasonFor(error);
    if (reason === undefined) {
      throw toAppException(error);
    }
    return { ok: false, reason };
  }
}

// Only these failures fall back to the local listing. Anything else is a real error for the caller.
// Standalone and mongos deployments without the sessions namespace report one of the missing-name
// codes, which counts as "unsupported".
function fallbackReasonFor(error: unknown): SessionFallbackReason | undefined {
  if (!(error instanceof MongoServerError)) {
    return undefined;
  }
  if (error.code === UNAUTHORIZED_CODE || error.codeName === 'Unauthorized') {
    return 'unauthorized';
  }
  if (
    error.code === COMMAND_NOT_FOUND_CODE ||
    error.code === NAMESPACE_NOT_FOUND_CODE ||
    error.codeName === 'CommandNotFound' ||
    error.codeName === 'NamespaceNotFound'
  ) {
    return 'unsupported';
  }
  return undefined;
}

async function readLocalRows(client: MongoClient, filter: Document): Promise<unknown[]> {
  try {
    const rows: unknown[] = await client
      .db('admin')
      .aggregate([{ $listLocalSessions: filter }])
      .toArray();
    return rows;
  } catch (error) {
    throw toAppException(error);
  }
}

// Best effort: the mapping is empty when the caller cannot read the local sessions.
async function userNamesByDigest(client: MongoClient): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const rows = await readLocalRows(client, { allUsers: true });
    for (const row of rows) {
      const digest = binaryHex(readField(readRecord(row, '_id'), 'uid'));
      const user = readString(row, 'user');
      if (digest !== undefined && user !== undefined) {
        names.set(digest, user);
      }
    }
  } catch {
    // Without the mapping, rows keep only userId.
  }
  return names;
}

function sessionFilter(options: ListSessionsOptions): Document {
  if (options.users !== undefined && options.users.length > 0) {
    return { users: options.users.map(sessionUser) };
  }
  return options.allUsers === true ? { allUsers: true } : {};
}

function sessionUser(user: SessionUser): { user: string; db: string } {
  if (user.user === '' || user.db === '') {
    throw validationError('A session user needs a name and a database');
  }
  return { user: user.user, db: user.db };
}

function toUuidBinary(id: string): Binary {
  if (!SESSION_ID_HEX.test(id)) {
    throw validationError('A session id must be 32 hexadecimal characters');
  }
  return new Binary(Buffer.from(id, 'hex'), Binary.SUBTYPE_UUID);
}

// Session rows carry the lsid UUID in _id.id and the user digest in _id.uid.
function toSessionInfo(
  row: unknown,
  names: ReadonlyMap<string, string> = new Map(),
): SessionInfo[] {
  const key = readRecord(row, '_id');
  const id = binaryHex(readField(key, 'id'));
  if (id === undefined) {
    return [];
  }
  const userId = binaryHex(readField(key, 'uid'));
  const user = readString(row, 'user') ?? (userId === undefined ? undefined : names.get(userId));
  const lastUse = readDate(row, 'lastUse');
  return [
    {
      id,
      ...definedEntry('user', user),
      ...definedEntry('name', userName(user)),
      ...definedEntry('db', userDatabase(user)),
      ...definedEntry('userId', userId),
      ...definedEntry('lastUse', lastUse?.toISOString()),
      ...definedEntry('expired', readBoolean(row, 'expired')),
    },
  ];
}

// The server writes the user as "name@db". The database follows the last "@", because a name such
// as "someone@example.com" from $external contains one too.
function userName(user: string | undefined): string | undefined {
  const at = user?.lastIndexOf('@') ?? -1;
  return user === undefined || at <= 0 ? undefined : user.slice(0, at);
}

function userDatabase(user: string | undefined): string | undefined {
  const at = user?.lastIndexOf('@') ?? -1;
  return user === undefined || at < 0 || at === user.length - 1 ? undefined : user.slice(at + 1);
}

function binaryHex(value: unknown): string | undefined {
  return value instanceof Binary ? value.toString('hex') : undefined;
}
