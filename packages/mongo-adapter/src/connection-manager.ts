import { MongoClient } from 'mongodb';
import {
  AppErrorException,
  appError,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type ConnectionStatus,
  type ConnectionTestResult,
} from '@mongo-gui/core';
import { buildClientOptions } from './client-options';
import { mapDriverError } from './errors';
import { readServerInfo } from './server-info';

export type StatusListener = (connectionId: string, status: ConnectionStatus) => void;

interface Entry {
  readonly status: ConnectionStatus;
  readonly client: MongoClient | undefined;
  readonly attempt: number;
}

export class ConnectionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<StatusListener>();
  private attemptCounter = 0;

  async connect(profile: ConnectionProfile): Promise<ConnectionStatus> {
    const id = profile.id;
    const previous = this.entries.get(id);
    if (previous !== undefined) {
      this.entries.delete(id);
      this.emit(id, { state: 'disconnected' });
    }
    // The connecting entry is stored before the first await, so a disconnect that
    // runs right after connect() sees it and supersedes this attempt.
    this.attemptCounter += 1;
    const attempt = this.attemptCounter;
    this.store(id, { state: 'connecting' }, undefined, attempt);
    await closeQuietly(previous?.client);

    let client: MongoClient | undefined;
    try {
      client = createClient(profile);
      await client.connect();
      const info = await readServerInfo(client);
      if (!this.isCurrent(id, attempt)) {
        await closeQuietly(client);
        return this.status(id);
      }
      const connected = client;
      connected.on('topologyClosed', () => this.handleTopologyClosed(id, connected));
      return this.store(id, { state: 'connected', ...info }, connected, attempt);
    } catch (error) {
      await closeQuietly(client);
      if (!this.isCurrent(id, attempt)) {
        return this.status(id);
      }
      return this.store(id, { state: 'error', error: mapDriverError(error) }, undefined, attempt);
    }
  }

  async disconnect(connectionId: string): Promise<void> {
    const entry = this.entries.get(connectionId);
    if (entry === undefined) {
      return;
    }
    this.entries.delete(connectionId);
    this.emit(connectionId, { state: 'disconnected' });
    await closeQuietly(entry.client);
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.disconnect(id)));
  }

  status(connectionId: string): ConnectionStatus {
    return this.entries.get(connectionId)?.status ?? { state: 'disconnected' };
  }

  isConnected(connectionId: string): boolean {
    return this.status(connectionId).state === 'connected';
  }

  getClient(connectionId: string): MongoClient {
    const client = this.entries.get(connectionId)?.client;
    if (client === undefined) {
      throw new AppErrorException(appError('NOT_CONNECTED', 'Not connected'));
    }
    return client;
  }

  async test(profile: ConnectionProfileInput): Promise<ConnectionTestResult> {
    let client: MongoClient | undefined;
    try {
      client = createClient(profile);
      await client.connect();
      const info = await readServerInfo(client);
      return { ok: true, serverVersion: info.serverVersion, topology: info.topology };
    } catch (error) {
      return { ok: false, error: mapDriverError(error) };
    } finally {
      await closeQuietly(client);
    }
  }

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private isCurrent(connectionId: string, attempt: number): boolean {
    return this.entries.get(connectionId)?.attempt === attempt;
  }

  private handleTopologyClosed(connectionId: string, client: MongoClient): void {
    const entry = this.entries.get(connectionId);
    if (entry?.client !== client) {
      return;
    }
    this.store(
      connectionId,
      { state: 'error', error: appError('CONNECTION_FAILED', 'Connection to the server closed') },
      undefined,
      entry.attempt,
    );
  }

  private store(
    connectionId: string,
    status: ConnectionStatus,
    client: MongoClient | undefined,
    attempt: number,
  ): ConnectionStatus {
    this.entries.set(connectionId, { status, client, attempt });
    this.emit(connectionId, status);
    return status;
  }

  private emit(connectionId: string, status: ConnectionStatus): void {
    for (const listener of this.listeners) {
      listener(connectionId, status);
    }
  }
}

function createClient(profile: ConnectionProfileInput): MongoClient {
  const { uri, options } = buildClientOptions(profile);
  return new MongoClient(uri, options);
}

async function closeQuietly(client: MongoClient | undefined): Promise<void> {
  if (client === undefined) {
    return;
  }
  try {
    await client.close();
  } catch {
    // The client is discarded either way, so a failed close has no caller to report to.
  }
}
