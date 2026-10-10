import { z } from 'zod';
import { ServerLogKindSchema } from './types';

// The RPC shapes of the diagnostics panel that the reply types in ./types do not cover. The
// connection id is added by the contract.

export const ServerLogRequestSchema = z.object({ kind: ServerLogKindSchema });

// The argv strings and the parsed options with URIs and secret fields masked, as canonical EJSON.
export const CommandLineReplySchema = z.object({
  argv: z.array(z.string()),
  parsed: z.unknown(),
});

// The document is canonical EJSON as a plain JSON object. Dates and Longs keep their wrappers.
export const ServerStatusReplySchema = z.object({
  at: z.string(),
  stripped: z.array(z.string()),
  document: z.record(z.string(), z.unknown()),
});

export const SessionListInputSchema = z.object({ allUsers: z.boolean().optional() });

export const SessionIdSchema = z.string().regex(/^[0-9a-f]{32}$/i, 'A session id is 32 hex digits');

export const KillSessionsInputSchema = z.object({
  ids: z.array(SessionIdSchema).min(1).max(500),
});

export const SessionUserSchema = z.object({
  user: z.string().trim().min(1),
  db: z.string().trim().min(1),
});

export const KillAllSessionsInputSchema = z.object({
  users: z.array(SessionUserSchema).min(1).max(50),
});

export const DatabaseTargetSchema = z.object({ database: z.string().min(1) });
export const CollectionTargetSchema = DatabaseTargetSchema.extend({
  collection: z.string().min(1),
});

export type ServerStatusReply = z.infer<typeof ServerStatusReplySchema>;
export type CommandLineReply = z.infer<typeof CommandLineReplySchema>;
export type SessionUserInput = z.infer<typeof SessionUserSchema>;
