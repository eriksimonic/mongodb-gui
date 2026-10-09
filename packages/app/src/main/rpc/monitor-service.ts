import {
  AppErrorException,
  DEFAULT_MONITOR_INTERVAL_MS,
  DEFAULT_MONITOR_RETENTION_MS,
  appError,
  isSyntheticOpid,
  type MonitorConfig,
  type MonitorSample,
  type RpcEvent,
  type RunningOperation,
} from '@mongo-gui/core';
import {
  Sampler,
  killOperation as killServerOperation,
  listOperations,
  type ListOperationsOptions,
} from '@mongo-gui/mongo-adapter';

/** The client a sampler or an operations call runs against. */
export type MonitorClient = Parameters<typeof killServerOperation>[0];

/** The part of Sampler that the service uses. The real class satisfies it. */
export type MonitorSampler = Pick<
  Sampler,
  'start' | 'stop' | 'setInterval' | 'samples' | 'onSample' | 'onError'
>;

export type SamplerFactory = (client: MonitorClient, config: MonitorConfig) => MonitorSampler;

export const defaultSamplerFactory: SamplerFactory = (client, config) =>
  new Sampler({ client, config });

export interface MonitorServiceDeps {
  /** Throws NOT_CONNECTED when the connection has no live client. */
  readonly getClient: (connectionId: string) => MonitorClient;
  readonly createSampler: SamplerFactory;
  readonly emit: (event: RpcEvent) => void;
}

export interface MonitorService {
  start(connectionId: string, intervalMs?: number): MonitorConfig;
  stop(connectionId: string): void;
  samples(connectionId: string, sinceIso?: string): MonitorSample[];
  setInterval(connectionId: string, intervalMs: number): MonitorConfig;
  operations(connectionId: string, options: ListOperationsOptions): Promise<RunningOperation[]>;
  killOperation(connectionId: string, opid: string | number): Promise<void>;
  /** Stops every sampler. Used on lock and on quit. */
  stopAll(): void;
}

interface Running {
  readonly sampler: MonitorSampler;
  config: MonitorConfig;
  readonly unsubscribe: (() => void)[];
}

/**
 * Owns one sampler per connection. A sampler starts on the first start call, stops on stop,
 * and forwards its samples and errors to the event sink until it stops.
 */
export function createMonitorService(deps: MonitorServiceDeps): MonitorService {
  const running = new Map<string, Running>();

  function stop(connectionId: string): void {
    const entry = running.get(connectionId);
    if (entry === undefined) {
      return;
    }
    running.delete(connectionId);
    for (const unsubscribe of entry.unsubscribe) {
      unsubscribe();
    }
    entry.sampler.stop();
  }

  return {
    start(connectionId, intervalMs) {
      const existing = running.get(connectionId);
      if (existing !== undefined) {
        if (intervalMs === undefined || intervalMs === existing.config.intervalMs) {
          return existing.config;
        }
        return applyInterval(existing, intervalMs);
      }
      const client = deps.getClient(connectionId);
      const config: MonitorConfig = {
        intervalMs: intervalMs ?? DEFAULT_MONITOR_INTERVAL_MS,
        retentionMs: DEFAULT_MONITOR_RETENTION_MS,
      };
      const sampler = deps.createSampler(client, config);
      const entry: Running = { sampler, config, unsubscribe: [] };
      entry.unsubscribe.push(
        sampler.onSample((sample) => {
          deps.emit({ type: 'monitor:sample', connectionId, sample });
        }),
        sampler.onError((error) => {
          deps.emit({ type: 'monitor:error', connectionId, error });
        }),
      );
      running.set(connectionId, entry);
      sampler.start();
      return config;
    },

    stop,

    samples(connectionId, sinceIso) {
      const samples = running.get(connectionId)?.sampler.samples() ?? [];
      if (sinceIso === undefined) {
        return samples;
      }
      const threshold = Date.parse(sinceIso);
      return samples.filter((sample) => Date.parse(sample.at) > threshold);
    },

    setInterval(connectionId, intervalMs) {
      const entry = running.get(connectionId);
      if (entry === undefined) {
        throw new AppErrorException(
          appError('VALIDATION', 'Monitoring is not running for this connection.'),
        );
      }
      return applyInterval(entry, intervalMs);
    },

    async operations(connectionId, options) {
      return listOperations(deps.getClient(connectionId), options);
    },

    async killOperation(connectionId, opid) {
      // Idle connections have no server opid. The schema already refuses them, and this check
      // keeps the guarantee for callers that skip the schema.
      if (isSyntheticOpid(opid)) {
        throw new AppErrorException(appError('VALIDATION', 'Idle connections cannot be killed.'));
      }
      await killServerOperation(deps.getClient(connectionId), opid);
    },

    stopAll() {
      for (const connectionId of [...running.keys()]) {
        stop(connectionId);
      }
    },
  };
}

function applyInterval(entry: Running, intervalMs: number): MonitorConfig {
  entry.sampler.setInterval(intervalMs);
  entry.config = { ...entry.config, intervalMs };
  return entry.config;
}
