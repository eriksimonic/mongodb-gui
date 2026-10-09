import { Binary, type Document, type MongoClient } from 'mongodb';
import type { SessionInfo, SessionList } from '@mongo-gui/core';
import {
  definedEntry,
  readBoolean,
  readDate,
  readField,
  readRecord,
  readString,
} from '../documents';
import { validationError } from '../management/errors';
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

// Lists sessions cluster-wide from config.system.sessions when the caller asks for other users
// and the server allows it. Otherwise, or when that read fails or finds nothing, it lists the
// sessions the connected server holds and reports the scope as "local".
export async function listSessions(
  client: MongoClient,
  options: ListSessionsOptions = {},
): Promise<SessionList> {
  const filter = sessionFilter(options);
  if (options.allUsers === true || (options.users?.length ?? 0) > 0) {
    try {
      const rows: unknown[] = await client
        .db('config')
        .collection('system.sessions')
        .aggregate([{ $listSessions: filter }])
        .toArray();
      if (rows.length > 0) {
        return { scope: 'all', sessions: rows.flatMap(toSessionInfo) };
      }
    } catch {
      // The user lacks the privilege, or the deployment has no config.system.sessions.
    }
  }
  const rows: unknown[] = await client
    .db('admin')
    .aggregate([{ $listLocalSessions: filter }])
    .toArray();
  return { scope: 'local', sessions: rows.flatMap(toSessionInfo) };
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

export async function killAllSessionsByUser(
  client: MongoClient,
  users: readonly SessionUser[],
): Promise<void> {
  if (users.length === 0) {
    throw validationError('Choose at least one user whose sessions to kill');
  }
  // Each pattern matches the sessions of one user. Patterns combine with OR on the server.
  // The caller needs the impersonate privilege. On 4.4, 6.0 and 8.0 a run of this command also
  // interrupted a running read from another user, so a caller should expect that side effect.
  const patterns = users.map((user) => ({ users: [sessionUser(user)] }));
  await runAdminCommand(client, { killAllSessionsByPattern: patterns });
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
function toSessionInfo(row: unknown): SessionInfo[] {
  const key = readRecord(row, '_id');
  const id = binaryHex(readField(key, 'id'));
  if (id === undefined) {
    return [];
  }
  const lastUse = readDate(row, 'lastUse');
  return [
    {
      id,
      ...definedEntry('user', readString(row, 'user')),
      ...definedEntry('userId', binaryHex(readField(key, 'uid'))),
      ...definedEntry('lastUse', lastUse?.toISOString()),
      ...definedEntry('expired', readBoolean(row, 'expired')),
    },
  ];
}

function binaryHex(value: unknown): string | undefined {
  return value instanceof Binary ? value.toString('hex') : undefined;
}
