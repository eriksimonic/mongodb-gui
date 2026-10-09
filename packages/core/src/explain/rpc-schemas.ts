import { z } from 'zod';
import { PlanTreeSchema, PlanVerbositySchema } from './plan-tree';

export const ExplainRunInputSchema = z.object({
  connectionId: z.uuid(),
  database: z.string().min(1),
  code: z.string().min(1),
  verbosity: PlanVerbositySchema,
});

export const ExplainRunCommandInputSchema = z.object({
  connectionId: z.uuid(),
  database: z.string().min(1),
  // The captured command as canonical or relaxed EJSON, for example a profiler entry's command.
  commandEjson: z.string().min(1),
  verbosity: PlanVerbositySchema,
  // Set for a profiler update or remove entry, whose command is a bare statement. The router
  // wraps the statement in the command that carries it, using the collection named here.
  profileOp: z.enum(['update', 'remove']).optional(),
  collection: z.string().min(1).optional(),
});

export const ExplainResultSchema = z.object({
  requestId: z.uuid(),
  tree: PlanTreeSchema,
  // The server's explain document as canonical EJSON, pretty printed.
  rawEjson: z.string(),
  elapsedMs: z.number().min(0),
});

export type ExplainRunInput = z.infer<typeof ExplainRunInputSchema>;
export type ExplainRunCommandInput = z.infer<typeof ExplainRunCommandInputSchema>;
export type ExplainResult = z.infer<typeof ExplainResultSchema>;
