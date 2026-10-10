import { describe, expect, it } from 'vitest';
import { parseToolsVersionOutput } from './version-output';

describe('parseToolsVersionOutput', () => {
  it('reads all three fields', () => {
    const out =
      'mongodump version: 100.19.1\ngit version: 7a1b2c\nGo version: go1.23.4\n   os: linux\n';
    expect(parseToolsVersionOutput(out)).toEqual({
      version: '100.19.1',
      gitVersion: '7a1b2c',
      goVersion: 'go1.23.4',
    });
  });

  it('reads mongorestore and handles CRLF and missing lines', () => {
    expect(parseToolsVersionOutput('mongorestore version: 100.9.0\r\n')).toEqual({
      version: '100.9.0',
    });
  });

  it('returns undefined for other output', () => {
    expect(parseToolsVersionOutput('mongod version: 7.0.0')).toBeUndefined();
    expect(parseToolsVersionOutput('')).toBeUndefined();
  });
});
