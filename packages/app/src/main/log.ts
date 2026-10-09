import { redactText } from './redact';

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  // Debug lines are written only when the logger was created with debug enabled.
  debug?(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  readonly debug?: boolean;
}

/**
 * Writes one JSON object per line. Every string value, including the message, passes
 * through redactText, so a URI with a password never reaches the output.
 */
export function createLogger(write: (line: string) => void, options: LoggerOptions = {}): Logger {
  const emit = (level: Level, message: string, fields: LogFields | undefined): void => {
    write(formatLine(level, message, fields));
  };
  return {
    ...(options.debug === true
      ? { debug: (message: string, fields?: LogFields) => emit('debug', message, fields) }
      : {}),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

// Debug lines are on only when MONGO_GUI_LOG_LEVEL is "debug", so a normal run stays quiet.
export const log: Logger = createLogger(
  (line) => {
    process.stderr.write(`${line}\n`);
  },
  { debug: process.env['MONGO_GUI_LOG_LEVEL'] === 'debug' },
);

function formatLine(level: Level, message: string, fields: LogFields | undefined): string {
  // Caller fields sit under their own key, so a field named message or level cannot replace
  // the entry's own values.
  const record = {
    time: new Date().toISOString(),
    level,
    message,
    fields: fields ?? {},
  };
  try {
    return JSON.stringify(record, (_key, value: unknown) =>
      typeof value === 'string' ? redactText(value) : value,
    );
  } catch {
    return JSON.stringify({
      time: record.time,
      level,
      message: redactText(message),
      fieldsError: 'fields could not be serialised',
    });
  }
}
