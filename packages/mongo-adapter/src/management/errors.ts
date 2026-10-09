import { AppErrorException, appError } from '@mongo-gui/core';
import { mapDriverError } from '../errors';

export const RESERVED_DATABASES: ReadonlySet<string> = new Set(['admin', 'local', 'config']);
const SYSTEM_PREFIX = 'system.';

export function validationError(message: string): AppErrorException {
  return new AppErrorException(appError('VALIDATION', message));
}

// Structural type for a core zod schema. The adapter does not depend on zod directly.
export interface SafeParser<T> {
  safeParse(input: unknown): SafeParseOutcome<T>;
}

type SafeParseOutcome<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      readonly error: {
        readonly issues: readonly {
          readonly path: readonly PropertyKey[];
          readonly message: string;
        }[];
      };
    };

export function parseInput<T>(schema: SafeParser<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
    throw validationError(`Invalid input, ${where}${issue?.message ?? 'unknown problem'}`);
  }
  return parsed.data;
}

export function toAppException(error: unknown): AppErrorException {
  if (error instanceof AppErrorException) {
    return error;
  }
  return new AppErrorException(mapDriverError(error));
}

export function refuseReservedDatabase(database: string, action: string): void {
  if (RESERVED_DATABASES.has(database)) {
    throw validationError(`Refusing to ${action} the ${database} database`);
  }
}

export function refuseSystemCollection(name: string, action: string): void {
  if (name.startsWith(SYSTEM_PREFIX)) {
    throw validationError(`Refusing to ${action} the system collection ${name}`);
  }
}
