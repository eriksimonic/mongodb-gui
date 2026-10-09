import { describe, expect, it } from 'vitest';
import type { ConnectionProfileInput } from '@mongo-gui/core';
import { buildClientOptions } from './client-options';

function profile(overrides: Partial<ConnectionProfileInput> = {}): ConnectionProfileInput {
  return { name: 'local', uri: 'mongodb://localhost:27017', ...overrides };
}

describe('buildClientOptions', () => {
  it('passes the uri through unchanged and sets the defaults', () => {
    const { uri, options } = buildClientOptions(profile());
    expect(uri).toBe('mongodb://localhost:27017');
    expect(options).toEqual({ appName: 'mongo-gui', serverSelectionTimeoutMS: 10000 });
  });

  it('uses connectTimeoutMs for server selection and connection timeouts', () => {
    const { options } = buildClientOptions(profile({ connectTimeoutMs: 2000 }));
    expect(options.serverSelectionTimeoutMS).toBe(2000);
    expect(options.connectTimeoutMS).toBe(2000);
  });

  it('maps readPreference when it is set', () => {
    const { options } = buildClientOptions(profile({ readPreference: 'secondaryPreferred' }));
    expect(options.readPreference).toBe('secondaryPreferred');
  });

  it('maps an enabled tls block with its files and certificate flag', () => {
    const { options } = buildClientOptions(
      profile({
        tls: {
          enabled: true,
          caFile: '/certs/ca.pem',
          certFile: '/certs/client.pem',
          allowInvalidCertificates: true,
        },
      }),
    );
    expect(options).toEqual({
      appName: 'mongo-gui',
      serverSelectionTimeoutMS: 10000,
      tls: true,
      tlsCAFile: '/certs/ca.pem',
      tlsCertificateKeyFile: '/certs/client.pem',
      tlsAllowInvalidCertificates: true,
    });
  });

  it('maps a tls block with only the enabled flag without file options', () => {
    const { options } = buildClientOptions(profile({ tls: { enabled: true } }));
    expect(options.tls).toBe(true);
    expect(Object.keys(options)).not.toContain('tlsCAFile');
    expect(Object.keys(options)).not.toContain('tlsCertificateKeyFile');
    expect(Object.keys(options)).not.toContain('tlsAllowInvalidCertificates');
  });

  it('turns tls off when the block says disabled', () => {
    const { options } = buildClientOptions(profile({ tls: { enabled: false } }));
    expect(options.tls).toBe(false);
    expect(Object.keys(options)).not.toContain('tlsCAFile');
  });

  it('never sets a key to undefined', () => {
    const { options } = buildClientOptions(profile({ tls: { enabled: true } }));
    const values = Object.values(options);
    expect(values).not.toContain(undefined);
    expect(Object.keys(options)).not.toContain('readPreference');
    expect(Object.keys(options)).not.toContain('connectTimeoutMS');
  });
});
