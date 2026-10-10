import { describe, expect, it } from 'vitest';
import {
  capDiagnosticText,
  isSecretKey,
  MAX_DIAGNOSTIC_TEXT_LENGTH,
  redactArgv,
  redactDiagnosticValue,
  redactRawLine,
} from './redact';

describe('redactDiagnosticValue', () => {
  it('masks fields named password, key file contents and certificate contents', () => {
    const value = {
      password: 'hunter2',
      tlsCertificateKeyFilePassword: 'pem-secret',
      keyFileContents: 'AAAA',
      certificateContents: '-----BEGIN',
      keyFile: '/etc/mongo/key',
    };

    expect(redactDiagnosticValue(value)).toEqual({
      password: '***',
      tlsCertificateKeyFilePassword: '***',
      keyFileContents: '***',
      certificateContents: '***',
      keyFile: '/etc/mongo/key',
    });
  });

  it('masks secret fields nested in arrays and objects', () => {
    expect(redactDiagnosticValue({ net: { tls: [{ sslPEMKeyPassword: 'x' }] } })).toEqual({
      net: { tls: [{ sslPEMKeyPassword: '***' }] },
    });
  });

  it('keeps null and undefined secret fields as they are', () => {
    expect(redactDiagnosticValue({ password: null })).toEqual({ password: null });
  });

  it('removes the password from URI strings and keeps other strings', () => {
    expect(redactDiagnosticValue(['mongodb://admin:s3cret@db:27017/', 'plain'])).toEqual([
      'mongodb://admin:***@db:27017/',
      'plain',
    ]);
  });

  it('redacts a URI inside a longer text', () => {
    expect(redactDiagnosticValue('Connecting to mongodb://a:b@h/ now')).toBe(
      'Connecting to mongodb://a:***@h/ now',
    );
  });

  it('leaves the input unchanged', () => {
    const input = { password: 'a' };
    redactDiagnosticValue(input);
    expect(input).toEqual({ password: 'a' });
  });
});

describe('isSecretKey', () => {
  it('matches the secret names case-insensitively', () => {
    expect(isSecretKey('PASSWORD')).toBe(true);
    expect(isSecretKey('keyFile')).toBe(false);
  });
});

describe('redactArgv', () => {
  it('masks the value of a secret flag in the "--flag value" form', () => {
    expect(
      redactArgv(['mongod', '--tlsCertificateKeyFilePassword', 'secret1', '--port', '27017']),
    ).toEqual(['mongod', '--tlsCertificateKeyFilePassword', '***', '--port', '27017']);
  });

  it('masks the text after "=" in the "--flag=value" form', () => {
    expect(
      redactArgv(['--tlsCertificateKeyFilePassword=secret2', '--sslPEMKeyPassword=x']),
    ).toEqual(['--tlsCertificateKeyFilePassword=***', '--sslPEMKeyPassword=***']);
  });

  it('masks every named secret and any flag ending in Password', () => {
    const names = [
      'tlsClusterPassword',
      'ldapBindPassword',
      'ldapQueryPassword',
      'kmipClientCertificatePassword',
      'someFuturePassword',
      'authPasswd',
      'mySecret',
      'accessToken',
    ];
    for (const name of names) {
      expect(redactArgv([`--${name}`, 'v'])).toEqual([`--${name}`, '***']);
    }
  });

  it('keeps key file paths and certificate file paths', () => {
    expect(
      redactArgv(['--keyFile', '/etc/key', '--tlsCertificateKeyFile', '/etc/tls.pem']),
    ).toEqual(['--keyFile', '/etc/key', '--tlsCertificateKeyFile', '/etc/tls.pem']);
  });

  it('masks other key flags that are not file paths', () => {
    expect(redactArgv(['--kmipKeyIdentifier', 'abc'])).toEqual(['--kmipKeyIdentifier', '***']);
  });

  it('redacts a URI inside a plain argument', () => {
    expect(redactArgv(['mongodb://admin:s3cret@db/'])).toEqual(['mongodb://admin:***@db/']);
  });
});

describe('redactRawLine', () => {
  it('masks a password attribute inside a JSON line', () => {
    const raw = JSON.stringify({ msg: 'auth', attr: { password: 'hunter2', user: 'a' } });
    const masked = redactRawLine(raw);
    expect(masked).not.toContain('hunter2');
    expect(JSON.parse(masked)).toEqual({ msg: 'auth', attr: { password: '***', user: 'a' } });
  });

  it('redacts the URIs of a text line', () => {
    expect(redactRawLine('connecting mongodb://a:b@h/')).toBe('connecting mongodb://a:***@h/');
  });
});

describe('capDiagnosticText', () => {
  it('keeps a short text as it is', () => {
    expect(capDiagnosticText('abc')).toEqual({ text: 'abc', truncated: false });
  });

  it('cuts a text over the cap and marks it as truncated', () => {
    const long = 'x'.repeat(MAX_DIAGNOSTIC_TEXT_LENGTH * 2);
    const capped = capDiagnosticText(long);
    expect(capped.truncated).toBe(true);
    expect(capped.text.endsWith('[truncated]')).toBe(true);
    expect(capped.text.length).toBeLessThan(long.length);
  });
});
