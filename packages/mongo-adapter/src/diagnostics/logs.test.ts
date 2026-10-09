import { describe, expect, it } from 'vitest';
import { parseLogLine } from './logs';

const JSON_LINE = JSON.stringify({
  t: { $date: '2026-01-01T00:00:00.000+00:00' },
  s: 'I',
  c: 'NETWORK',
  id: 22943,
  ctx: 'listener',
  msg: 'Connection accepted',
  attr: { remote: '127.0.0.1:50000', connectionId: 7 },
});

describe('parseLogLine', () => {
  it('splits a JSON line into its structured fields', () => {
    expect(parseLogLine(JSON_LINE)).toEqual({
      ts: '2026-01-01T00:00:00.000+00:00',
      severity: 'I',
      component: 'NETWORK',
      id: 22943,
      context: 'listener',
      message: 'Connection accepted',
      attributes: { remote: '127.0.0.1:50000', connectionId: 7 },
      raw: JSON_LINE,
    });
  });

  it('keeps only the raw text for a line that is not JSON', () => {
    const text = '2026-01-01T00:00:00.000+0000 I  NETWORK  [listener] Connection accepted';
    expect(parseLogLine(text)).toEqual({ message: text, raw: text });
  });

  it('falls back when the JSON has no message', () => {
    const line = JSON.stringify({ s: 'W', c: 'CONTROL' });
    expect(parseLogLine(line)).toEqual({ message: line, raw: line });
  });

  it('falls back for JSON that is not an object', () => {
    expect(parseLogLine('[1,2]')).toEqual({ message: '[1,2]', raw: '[1,2]' });
    expect(parseLogLine('42')).toEqual({ message: '42', raw: '42' });
  });

  it('never throws on an empty or broken line', () => {
    expect(parseLogLine('')).toEqual({ message: '', raw: '' });
    expect(parseLogLine('{"msg": ')).toEqual({ message: '{"msg": ', raw: '{"msg": ' });
  });

  it('accepts a timestamp given as a plain string', () => {
    const line = JSON.stringify({ t: '2026-01-01T00:00:00Z', msg: 'plain time' });
    expect(parseLogLine(line).ts).toBe('2026-01-01T00:00:00Z');
  });
});
