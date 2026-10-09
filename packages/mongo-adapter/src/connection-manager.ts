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
}

export class ConnectionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<StatusListener>();

  async connect(profile: ConnectionProfile): Promise<ConnectionStatus> {
    await this.disconnect(profile.id);
    this.store(profile.id, { state: 'connecting' }, undefined);
    let client: MongoClient | undefined;
    try {
      client = createClient(profile);
      await client.connect();
      const info = await readServerInfo(client);
      const connected = client;
      connected.on('topologyClosed', () => this.handleTopologyClosed(profile.id, connected));
      return this.store(profile.id, { state: 'connected', ...info }, connected);
    } catch (error) {
      await closeQuietly(client);
      return this.store(profile.id, { state: 'error', error: mapDriverError(error) }, undefined);
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

  private handleTopologyClosed(connectionId: string, client: MongoClient): void {
    if (this.entries.get(connectionId)?.client !== client) {
      return;
    }
    this.store(
      connectionId,
      { state: 'error', error: appError('CONNECTION_FAILED', 'Connection to the server closed') },
      undefined,
    );
  }

  private store(
    connectionId: string,
    status: ConnectionStatus,
    client: MongoClient | undefined,
  ): ConnectionStatus {
    this.entries.set(connectionId, { status, client });
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
