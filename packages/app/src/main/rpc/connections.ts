import { readFileSync, statSync } from 'node:fs';
import { exportTargetProblem, replaceFile } from './export-file';
import {
  AppErrorException,
  CONNECTIONS_FILE_MAX_BYTES,
  ConnectionProfileSummarySchema,
  describeConnectionUri,
  planConnectionsImport,
  type ConnectionImportAction,
  type ConnectionsImportResult,
  appError,
  redactUri,
  rpcContract,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type ConnectionStatus,
  directConnectionName,
  directUriFor,
} from '@mongo-gui/core';
import type { ConnectionManager } from '@mongo-gui/mongo-adapter';
import {
  exportConnections,
  importConnections,
  type ConnectionsRepository,
} from '@mongo-gui/storage';
import type { DockerRuntime } from '../docker/runtime';
import { requireDocker } from './docker';
import { entry, type Operation } from './operation';
import { pickedFile, resolveRequestPath } from './picked-paths';

export interface ConnectionsDeps {
  /** The connection registry. The real ConnectionManager satisfies it. */
  readonly connections: Pick<ConnectionManager, 'connect' | 'disconnect' | 'status' | 'test'>;
  readonly repos: () => { readonly connections: ConnectionsRepository };
  /** Reads a profile without failing. A locked vault or a missing id gives undefined. */
  readonly profileById: (id: string) => ConnectionProfile | undefined;
  /** Local Docker support. A docker profile connects through it. Undefined makes that connect fail with INTERNAL. */
  readonly docker: DockerRuntime | undefined;
  /** Absolute paths the user picked in a save dialog this session. An export may replace only these. */
  readonly savePaths: Set<string>;
  /** Files picked in an open dialog this session. An import reads only these, one use each. */
  readonly openedFiles: Set<string>;
  /** Refuses an export whose folder is missing. The transfers use it too. */
  readonly refuseMissingFolder: (path: string) => void;
}

export function connectionsOperations(deps: ConnectionsDeps): [string, Operation][] {
  const repos = deps.repos;
  const { connections, profileById, savePaths, openedFiles, refuseMissingFolder } = deps;
  const docker = (): DockerRuntime => requireDocker(deps.docker);

  /** Records the time of a successful connect on the profile, then returns the status unchanged. */
  const stamped = (id: string, status: ConnectionStatus): ConnectionStatus => {
    if (status.state === 'connected') {
      repos().connections.markAccessed(id);
    }
    return status;
  };

  /** Disconnects a connection, then frees the forwarder when the connection was a docker profile. */
  const disconnectConnection = async (
    connectionId: string,
    profile: ConnectionProfile | undefined,
  ): Promise<void> => {
    await connections.disconnect(connectionId);
    await deps.docker?.releaseProfile(profile);
  };

  return [
    entry('connections.list', rpcContract.connections.list, () =>
      repos()
        .connections.list()
        .map((profile) => toSummary(profile)),
    ),
    entry('connections.get', rpcContract.connections.get, (input) =>
      repos().connections.get(input.id),
    ),
    entry('connections.create', rpcContract.connections.create, (input) =>
      repos().connections.create(input),
    ),
    entry('connections.createDirect', rpcContract.connections.createDirect, (input) => {
      const parent = repos().connections.get(input.id);
      return repos().connections.create({
        ...(parent.color === undefined ? {} : { color: parent.color }),
        ...(parent.tls === undefined ? {} : { tls: parent.tls }),
        ...(parent.readPreference === undefined ? {} : { readPreference: parent.readPreference }),
        ...(parent.connectTimeoutMs === undefined
          ? {}
          : { connectTimeoutMs: parent.connectTimeoutMs }),
        name: directConnectionName(parent.name, input.host),
        uri: directUriFor(parent.uri, input.host),
        source: 'manual',
        dockerContainerId: undefined,
      });
    }),
    entry('connections.update', rpcContract.connections.update, (input) =>
      repos().connections.update(input.id, definedFields(input.patch)),
    ),
    entry('connections.remove', rpcContract.connections.remove, async (input) => {
      const profile = profileById(input.id);
      repos().connections.remove(input.id);
      await disconnectConnection(input.id, profile);
    }),
    entry('connections.test', rpcContract.connections.test, (input) => connections.test(input)),
    entry('connections.connect', rpcContract.connections.connect, async (input) => {
      const profile = repos().connections.get(input.id);
      // A docker profile is rebuilt from its container, because its forwarder port changes.
      if (profile.source === 'docker' && profile.dockerContainerId !== undefined) {
        const result = await docker().connect(profile.dockerContainerId);
        // The tree reads a status here. The dialog opens from docker.connect, so this reports the error.
        if ('kind' in result) {
          return {
            state: 'error',
            error: appError('AUTH_FAILED', 'The server needs a user name and password.'),
          };
        }
        return stamped(input.id, result.status);
      }
      return stamped(input.id, await connections.connect(profile));
    }),
    entry('connections.disconnect', rpcContract.connections.disconnect, (input) =>
      disconnectConnection(input.id, profileById(input.id)),
    ),
    entry('connections.status', rpcContract.connections.status, (input) =>
      connections.status(input.id),
    ),
    entry('connections.exportToFile', rpcContract.connections.exportToFile, (input) => {
      const path = resolveRequestPath(input.path);
      refuseUnpickedSave(path, savePaths);
      refuseMissingFolder(path);
      const problem = exportTargetProblem(path);
      if (problem !== undefined) {
        throw new AppErrorException(appError('VALIDATION', problem));
      }
      const profiles = [...new Set(input.profileIds)].map((id) => repos().connections.get(id));
      // The pick is good for one write. It is used up only after the file is in place.
      replaceFile(path, exportConnections(profiles, input.passphrase));
      savePaths.delete(path);
    }),
    entry('connections.previewImport', rpcContract.connections.previewImport, (input) => {
      const existing = repos().connections.list();
      // A preview reads the file, so it reads only a picked file. It does not use up the pick.
      const incoming = readConnectionsFile(pickedFile(input.path, openedFiles), input.passphrase);
      const names = new Set(existing.map((connection) => connection.name));
      return {
        profiles: incoming.map((profile) => ({
          name: profile.name,
          ...describeConnectionUri(profile.uri),
          collides: names.has(profile.name),
        })),
      };
    }),
    entry('connections.importFromFile', rpcContract.connections.importFromFile, async (input) => {
      const existing = repos().connections.list();
      const path = pickedFile(input.path, openedFiles);
      const incoming = readConnectionsFile(path, input.passphrase);
      const plan = planConnectionsImport(incoming, existing, input.mode);
      // A transaction cannot wait, so each replaced connection disconnects before the writes start.
      for (const action of plan) {
        if (action.kind === 'replace') {
          const current = existing.find((connection) => connection.id === action.targetId);
          await disconnectConnection(action.targetId, current);
        }
      }
      // One transaction holds every write. A failed write rolls back the others, and the pick stays
      // usable, so the same file can be imported again.
      repos().connections.transaction(() => {
        for (const action of plan) {
          if (action.kind === 'create') {
            repos().connections.create(action.input);
          } else if (action.kind === 'replace') {
            repos().connections.update(action.targetId, replacementPatch(action.input));
          }
        }
      });
      openedFiles.delete(path);
      return summariseImportPlan(plan);
    }),
  ];
}

/**
 * Drops keys whose value is undefined. Zod's partial output marks absent keys as optional
 * with an explicit undefined type, which exactOptionalPropertyTypes rejects in the repository.
 */
function definedFields(
  patch: Partial<Record<keyof ConnectionProfileInput, unknown>>,
): Partial<ConnectionProfileInput> {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as Partial<ConnectionProfileInput>;
}

function toSummary(profile: ConnectionProfile): unknown {
  return ConnectionProfileSummarySchema.parse({
    ...profile,
    uriRedacted: redactUri(profile.uri),
  });
}

/** Counts what an import plan did. A renamed entry also counts as imported. */
function summariseImportPlan(plan: readonly ConnectionImportAction[]): ConnectionsImportResult {
  const result = { imported: 0, skipped: 0, renamed: 0, replaced: 0 };
  for (const action of plan) {
    if (action.kind === 'skip') {
      result.skipped += 1;
    } else if (action.kind === 'create') {
      result.imported += 1;
      result.renamed += action.renamed ? 1 : 0;
    } else {
      result.replaced += 1;
    }
  }
  return result;
}

/**
 * A connections export writes only to a path the save dialog returned this session. The path must
 * already be a pick, so an existing file is replaced only when the user picked it.
 */
function refuseUnpickedSave(path: string, picked: ReadonlySet<string>): void {
  if (!picked.has(path)) {
    throw new AppErrorException(appError('VALIDATION', 'Choose the file with Save as first.'));
  }
}

/** Reads and decrypts a connections file the open dialog returned. The size is checked before the read. */
function readConnectionsFile(path: string, passphrase: string): ConnectionProfile[] {
  let bytes: Buffer;
  try {
    if (statSync(path).size > CONNECTIONS_FILE_MAX_BYTES) {
      throw new AppErrorException(
        appError('VALIDATION', 'The file is too large to be a connections file.'),
      );
    }
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof AppErrorException) {
      throw error;
    }
    throw new AppErrorException(appError('VALIDATION', 'The file could not be read.'));
  }
  return importConnections(bytes, passphrase);
}

/**
 * The patch that makes a stored connection match an imported one. Each optional field the file
 * leaves out is set to undefined, so the store drops it and the old value does not survive.
 */
function replacementPatch(input: ConnectionProfileInput): Partial<ConnectionProfileInput> {
  return {
    name: input.name,
    uri: input.uri,
    color: input.color,
    tls: input.tls,
    readPreference: input.readPreference,
    connectTimeoutMs: input.connectTimeoutMs,
    source: input.source,
    dockerContainerId: input.dockerContainerId,
  } as Partial<ConnectionProfileInput>;
}
