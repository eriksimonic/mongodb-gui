import { describe, expect, it } from 'vitest';
import { isSecretKey, redactDiagnosticValue } from './redact';

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
