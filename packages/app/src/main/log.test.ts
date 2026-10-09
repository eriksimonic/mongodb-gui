import { describe, expect, it } from 'vitest';
import { createLogger } from './log';

function capture(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  return { lines, logger: createLogger((line) => lines.push(line)) };
}

describe('createLogger', () => {
  it('writes one JSON line per call with level, message and fields', () => {
    const { lines, logger } = capture();

    logger.warn('slow start', { attempt: 2 });

    expect(lines).toHaveLength(1);
    const record: unknown = JSON.parse(lines[0] ?? '');
    expect(record).toMatchObject({ level: 'warn', message: 'slow start', attempt: 2 });
    expect(record).toHaveProperty('time');
  });

  it('masks the password in a URI that appears in the message', () => {
    const { lines, logger } = capture();

    logger.error('connect failed for mongodb://u:p@h');

    expect(lines[0]).toContain('mongodb://u:***@h');
    expect(lines[0]).not.toContain('u:p@h');
  });

  it('masks URIs in nested string fields, including SRV URIs inside a sentence', () => {
    const { lines, logger } = capture();

    logger.info('dns lookup', {
      uri: 'mongodb://app:hunter2@localhost:27017/?authSource=admin',
      detail: 'server mongodb+srv://ops:s3cret@cluster.example.net/db refused',
    });

    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).not.toContain('s3cret');
    expect(lines[0]).toContain('mongodb://app:***@localhost:27017/');
    expect(lines[0]).toContain('mongodb+srv://ops:***@cluster.example.net/db');
  });

  it('reports unserialisable fields without throwing', () => {
    const { lines, logger } = capture();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    logger.info('loop', circular);

    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      level: 'info',
      message: 'loop',
      fieldsError: 'fields could not be serialised',
    });
  });
});
