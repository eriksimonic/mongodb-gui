import { AppErrorException, appError, type AppErrorCode, type RpcCall } from '@mongo-gui/core';
import type { z } from 'zod';

export function fail(code: AppErrorCode, message: string, detail?: string): AppErrorException {
  return new AppErrorException(appError(code, message, detail));
}

export function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Validates a value against a contract schema and maps failures to AppError codes. */
export function parseWith<T>(schema: z.ZodType, value: unknown, code: AppErrorCode): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const message = result.error.issues[0]?.message ?? 'Invalid input';
    throw fail(code, message);
  }
  return result.data as T;
}

/**
 * Wraps one contract call. Input is validated before the call runs, the output is validated
 * before it is returned, and every call waits for the configured latency first.
 */
export function method<I extends z.ZodType, O extends z.ZodType>(
  definition: RpcCall<I, O>,
  latencyMs: number,
  run: (input: z.output<I>) => z.output<O> | Promise<z.output<O>>,
): (raw: z.input<I>) => Promise<z.output<O>> {
  return async (raw) => {
    const input = parseWith<z.output<I>>(definition.input, raw, 'VALIDATION');
    await delay(latencyMs);
    const output = await run(input);
    return parseWith<z.output<O>>(definition.output, output, 'INTERNAL');
  };
}
