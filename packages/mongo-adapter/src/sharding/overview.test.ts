import type { MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { outcomeWithin, silentUnlessBounded, type CommandOptions } from '../test/silent-server';
import { getShardingOverview } from './overview';

describe('getShardingOverview', () => {
  it('bounds the buildInfo read, so a server that never answers it cannot hold the overview', async () => {
    const commands: Array<{ name: string; timeoutMS: number | undefined }> = [];
    // A read other than a command returns a chain that never settles. The overview builds all its
    // reads at once, so every read must be a call that returns, and the buildInfo call is recorded.
    const pendingChain: unknown = new Proxy({}, { get: () => () => pendingChain });
    const database = new Proxy(
      {
        // The hello reports a mongos. Every other command is silent unless it is bounded.
        command: (document: Record<string, unknown>, options?: CommandOptions) => {
          commands.push({ name: Object.keys(document)[0] ?? '', timeoutMS: options?.timeoutMS });
          if ('hello' in document) {
            return Promise.resolve({ msg: 'isdbgrid' });
          }
          return silentUnlessBounded(options);
        },
      },
      {
        get: (target: Record<string, unknown>, prop: string | symbol) =>
          prop in target ? target[prop as string] : () => pendingChain,
      },
    );
    const client = {
      options: { serverSelectionTimeoutMS: 10_000 },
      db: () => database,
    } as unknown as MongoClient;

    // The overview reads run in parallel, so the buildInfo call is sent before the wait ends.
    await outcomeWithin(getShardingOverview(client), 50);

    expect(commands.find((command) => command.name === 'buildInfo')?.timeoutMS).toBe(10_000);
  });
});
