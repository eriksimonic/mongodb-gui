import { rpcContract, type CallInput, type SchemaReport } from '@mongo-gui/core';
import { estimatedDocumentCount } from '@mongo-gui/mongo-adapter';
import { driverCall, entry, type Operation } from './operation';

/** The client a schema call runs against. */
type SchemaClient = Parameters<typeof estimatedDocumentCount>[0];

/** The shell runtime calls the schema sample uses. */
export interface SchemaShell {
  sampleSchema(
    input: Pick<
      CallInput<typeof rpcContract.schema.analyse>,
      'connectionId' | 'database' | 'collection' | 'size' | 'strategy'
    >,
  ): Promise<{ sampled: number; fields: SchemaReport['fields'] }>;
}

/** What the schema calls need from the router. */
export interface SchemaDeps {
  readonly getClient: (connectionId: string) => SchemaClient;
  /** Runs the action on the connection's shell. The router checks the connection first. */
  readonly shellCall: <T>(
    connectionId: string,
    action: (shell: SchemaShell) => Promise<T>,
  ) => Promise<T>;
}

/** Schema analysis. The sample comes from the shell runtime and the total from the server. */
export function schemaOperations(deps: SchemaDeps): [string, Operation][] {
  return [
    // The sample comes from the shell runtime. The total comes from the server's metadata.
    entry('schema.analyse', rpcContract.schema.analyse, async (input): Promise<SchemaReport> => {
      const sample = await deps.shellCall(input.connectionId, (shell) =>
        shell.sampleSchema({
          connectionId: input.connectionId,
          database: input.database,
          collection: input.collection,
          size: input.size,
          strategy: input.strategy,
        }),
      );
      const total = await driverCall(() =>
        estimatedDocumentCount(
          deps.getClient(input.connectionId),
          input.database,
          input.collection,
        ),
      );
      return {
        database: input.database,
        collection: input.collection,
        sampled: sample.sampled,
        total,
        fields: sample.fields,
        at: new Date().toISOString(),
      };
    }),
  ];
}
