import type { MongoClient } from 'mongodb';
import type {
  BackupNamespaceInfo,
  BackupScope,
  BackupServerInfo,
  CollectionInfo,
} from '@mongo-gui/core';
import { listCollections, listDatabases } from '../catalog';
import { definedEntry, hasKey, readRecord, readString } from '../documents';
import { readServerInfo } from '../server-info';

export const MAX_BACKUP_NAMESPACES = 5000;

const SYSTEM_DATABASES = new Set(['local']);

/**
 * What the backup dialog needs to know about the server, and with a scope, the collections the
 * dump would cover. Reading FCV, the storage engine or a count may be refused, so those parts are
 * optional and never fail the call.
 */
export async function readBackupServerInfo(
  client: MongoClient,
  scope?: BackupScope,
): Promise<BackupServerInfo> {
  const [info, fcv, storageEngine, databases] = await Promise.all([
    readServerInfo(client),
    readFeatureCompatibilityVersion(client),
    readStorageEngine(client),
    listDatabases(client),
  ]);
  const databaseNames = databases.map((database) => database.name);
  const { namespaces, truncated } = await readScopeNamespaces(client, scope, databaseNames);
  return {
    serverVersion: info.serverVersion,
    ...definedEntry('fcv', fcv),
    ...definedEntry('storageEngine', storageEngine),
    topology: info.topology,
    ...definedEntry('setName', info.setName),
    directConnection: info.directConnection === true,
    hosts: info.hosts,
    databases: databaseNames,
    namespaces,
    namespacesTruncated: truncated,
  };
}

/** The databases a scope covers. A whole-server dump skips the local database, as mongodump does. */
export function scopeDatabases(scope: BackupScope, all: readonly string[]): string[] {
  switch (scope.kind) {
    case 'server':
      return all.filter((name) => !SYSTEM_DATABASES.has(name));
    case 'database':
    case 'collection':
      return [scope.database];
    case 'databases':
      return [...scope.databases];
  }
}

/** The namespace entry for one collection row, without a document count. */
export function toNamespaceInfo(database: string, info: CollectionInfo): BackupNamespaceInfo {
  const options = info.options;
  return {
    database,
    collection: info.name,
    type: info.type === 'view' || info.type === 'timeseries' ? info.type : 'collection',
    ...(options !== undefined && options['capped'] === true ? { capped: true } : {}),
    ...(options !== undefined && hasKey(options, 'clusteredIndex') ? { clustered: true } : {}),
    ...(options !== undefined && hasKey(options, 'encryptedFields') ? { encrypted: true } : {}),
  };
}

export function readFcvValue(reply: unknown): string | undefined {
  return readString(readRecord(reply, 'featureCompatibilityVersion'), 'version');
}

export function readStorageEngineName(status: unknown): string | undefined {
  return readString(readRecord(status, 'storageEngine'), 'name');
}

async function readFeatureCompatibilityVersion(client: MongoClient): Promise<string | undefined> {
  try {
    const reply: unknown = await client
      .db('admin')
      .command({ getParameter: 1, featureCompatibilityVersion: 1 });
    return readFcvValue(reply);
  } catch {
    return undefined;
  }
}

async function readStorageEngine(client: MongoClient): Promise<string | undefined> {
  try {
    const status: unknown = await client.db('admin').command({ serverStatus: 1 });
    return readStorageEngineName(status);
  } catch {
    return undefined;
  }
}

interface ScopeNamespaces {
  readonly namespaces: BackupNamespaceInfo[];
  readonly truncated: boolean;
}

async function readScopeNamespaces(
  client: MongoClient,
  scope: BackupScope | undefined,
  allDatabases: readonly string[],
): Promise<ScopeNamespaces> {
  const namespaces: BackupNamespaceInfo[] = [];
  if (scope === undefined) {
    return { namespaces, truncated: false };
  }
  for (const database of scopeDatabases(scope, allDatabases)) {
    const collections = await listCollections(client, database);
    for (const info of collections) {
      if (scope.kind === 'collection' && info.name !== scope.collection) {
        continue;
      }
      if (namespaces.length >= MAX_BACKUP_NAMESPACES) {
        return { namespaces, truncated: true };
      }
      const base = toNamespaceInfo(database, info);
      const documents =
        base.type === 'collection' ? await countOrUndefined(client, base) : undefined;
      namespaces.push({ ...base, ...definedEntry('documents', documents) });
    }
  }
  return { namespaces, truncated: false };
}

async function countOrUndefined(
  client: MongoClient,
  namespace: BackupNamespaceInfo,
): Promise<number | undefined> {
  try {
    return await client
      .db(namespace.database)
      .collection(namespace.collection)
      .estimatedDocumentCount();
  } catch {
    return undefined;
  }
}
