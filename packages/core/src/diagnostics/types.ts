import { z } from 'zod';

const nonNegativeInt = z.number().int().nonnegative();

export const ServerLogKindSchema = z.enum(['global', 'startupWarnings']);

// One line of a getLog reply. JSON lines (MongoDB 4.4 and newer) fill the structured fields.
// Other lines keep only the message and the raw text.
export const LogLineSchema = z.object({
  ts: z.string().optional(),
  severity: z.string().optional(),
  component: z.string().optional(),
  id: z.number().int().optional(),
  context: z.string().optional(),
  message: z.string(),
  attributes: z.unknown().optional(),
  raw: z.string(),
});

export const ServerLogSchema = z.object({
  kind: ServerLogKindSchema,
  total: nonNegativeInt,
  lines: z.array(LogLineSchema),
});

export const LogComponentVerbositySchema = z.object({
  verbosity: z.number().int(),
  components: z.record(z.string(), z.number().int()),
});

export const ServerParameterSchema = z.object({
  name: z.string(),
  value: z.unknown(),
  valueEjson: z.string(),
});

export const CommandLineOptionsSchema = z.object({
  argv: z.array(z.string()),
  parsed: z.unknown(),
  parsedEjson: z.string(),
});

export const HostInfoSchema = z.object({
  hostname: z.string().optional(),
  os: z
    .object({
      type: z.string().optional(),
      name: z.string().optional(),
      version: z.string().optional(),
    })
    .optional(),
  cpu: z
    .object({
      arch: z.string().optional(),
      cores: nonNegativeInt.optional(),
    })
    .optional(),
  memSizeMb: z.number().nonnegative().optional(),
  numaEnabled: z.boolean().optional(),
  // Relaxed EJSON text. Parse with JSON.parse; Dates, Longs above 2^53 and Timestamps stay as
  // single-key wrapper objects. "$" keys are not escaped.
  rawJson: z.string(),
});

export const BuildInfoSchema = z.object({
  version: z.string(),
  gitVersion: z.string().optional(),
  modules: z.array(z.string()),
  allocator: z.string().optional(),
  javascriptEngine: z.string().optional(),
  storageEngines: z.array(z.string()),
  bits: z.number().int().optional(),
  maxBsonObjectSize: nonNegativeInt.optional(),
  // Relaxed EJSON text. Parse with JSON.parse; Dates, Longs above 2^53 and Timestamps stay as
  // single-key wrapper objects. "$" keys are not escaped.
  rawJson: z.string(),
});

export const OpStatSchema = z.object({
  time: z.number().nonnegative(),
  count: nonNegativeInt,
});

export const TopEntrySchema = z.object({
  ns: z.string(),
  total: OpStatSchema,
  readLock: OpStatSchema,
  writeLock: OpStatSchema,
  queries: OpStatSchema,
  getmore: OpStatSchema,
  insert: OpStatSchema,
  update: OpStatSchema,
  remove: OpStatSchema,
  commands: OpStatSchema,
});

export const ConnPoolHostStatsSchema = z.object({
  inUse: nonNegativeInt,
  available: nonNegativeInt,
  created: nonNegativeInt,
});

export const ConnPoolStatsSchema = z.object({
  totalInUse: nonNegativeInt,
  totalAvailable: nonNegativeInt,
  totalCreated: nonNegativeInt,
  hosts: z.record(z.string(), ConnPoolHostStatsSchema),
  // Relaxed EJSON text. Parse with JSON.parse; Dates, Longs above 2^53 and Timestamps stay as
  // single-key wrapper objects. "$" keys are not escaped.
  rawJson: z.string(),
});

// user is the server's "name@db" text. name and db split it at the last "@".
export const SessionInfoSchema = z.object({
  id: z.string(),
  user: z.string().optional(),
  name: z.string().optional(),
  db: z.string().optional(),
  userId: z.string().optional(),
  lastUse: z.string().optional(),
  expired: z.boolean().optional(),
});

// "all" comes from config.system.sessions. "local" is what the connected server holds.
export const SessionScopeSchema = z.enum(['local', 'all']);

export const SessionFallbackReasonSchema = z.enum(['unauthorized', 'unsupported']);

export const SessionListSchema = z.object({
  scope: SessionScopeSchema,
  // Set when a "scope: all" read was attempted and failed, so the local list was returned instead.
  fallbackReason: SessionFallbackReasonSchema.optional(),
  sessions: z.array(SessionInfoSchema),
});

export const ServerStatusTreeSchema = z.object({
  at: z.string(),
  // Relaxed EJSON text. Parse with JSON.parse; Dates, Longs above 2^53 and Timestamps stay as
  // single-key wrapper objects. "$" keys are not escaped.
  rawJson: z.string(),
  // The same reply in canonical EJSON text. Parse with JSON.parse. Dates and Longs keep their
  // wrappers. It is read through the driver, so a Long that fits a number reads as an int.
  canonicalJson: z.string(),
  stripped: z.array(z.string()),
});

export type ServerLogKind = z.infer<typeof ServerLogKindSchema>;
export type LogLine = z.infer<typeof LogLineSchema>;
export type ServerLog = z.infer<typeof ServerLogSchema>;
export type LogComponentVerbosity = z.infer<typeof LogComponentVerbositySchema>;
export type ServerParameter = z.infer<typeof ServerParameterSchema>;
export type CommandLineOptions = z.infer<typeof CommandLineOptionsSchema>;
export type HostInfo = z.infer<typeof HostInfoSchema>;
export type BuildInfo = z.infer<typeof BuildInfoSchema>;
export type OpStat = z.infer<typeof OpStatSchema>;
export type TopEntry = z.infer<typeof TopEntrySchema>;
export type ConnPoolHostStats = z.infer<typeof ConnPoolHostStatsSchema>;
export type ConnPoolStats = z.infer<typeof ConnPoolStatsSchema>;
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
export type SessionScope = z.infer<typeof SessionScopeSchema>;
export type SessionList = z.infer<typeof SessionListSchema>;
export type ServerStatusTree = z.infer<typeof ServerStatusTreeSchema>;
export type SessionFallbackReason = z.infer<typeof SessionFallbackReasonSchema>;
