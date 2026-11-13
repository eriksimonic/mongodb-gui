import { AppErrorException, type ConnectionProfile } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { withoutInsecureTls } from './insecure-tls';

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: '0b5c8a6e-2a4f-4c1e-9d3a-7f2e1b6c4d10',
    name: 'imported',
    uri: 'mongodb://localhost:27017',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function uriOf(uri: string): string {
  return withoutInsecureTls(profile({ uri })).uri;
}

describe('withoutInsecureTls', () => {
  it('drops the insecure options whatever the case of their names', () => {
    const result = uriOf(
      'mongodb://h/?TLSInsecure=true&tlsallowinvalidhostnames=true&TLSALLOWINVALIDCERTIFICATES=true&replicaSet=rs0',
    );
    expect(result).not.toMatch(/tlsinsecure|tlsallowinvalid/i);
    expect(result).toContain('replicaSet=rs0');
  });

  it('drops the insecure options from an mongodb+srv URI', () => {
    const result = uriOf(
      'mongodb+srv://u:p@cluster.example.com/?retryWrites=true&tlsInsecure=true',
    );
    expect(result.startsWith('mongodb+srv://')).toBe(true);
    expect(result).not.toMatch(/tlsinsecure/i);
    expect(result).toContain('retryWrites=true');
  });

  it('keeps every host of a multi-host URI', () => {
    const result = uriOf(
      'mongodb://h1:27017,h2:27017/?replicaSet=rs0&tlsAllowInvalidHostnames=true',
    );
    expect(result).toContain('h1:27017,h2:27017');
    expect(result).not.toMatch(/tlsallowinvalid/i);
    expect(result).toContain('replicaSet=rs0');
  });

  it('keeps a percent-encoded password', () => {
    const result = uriOf('mongodb://app:p%3F%40%26%25@h/?tlsInsecure=true&replicaSet=rs0');
    expect(result).toContain('app:p%3F%40%26%25@h');
    expect(result).not.toMatch(/tlsinsecure/i);
  });

  it('returns a URI with no insecure option byte for byte', () => {
    const uri = 'mongodb://u:p%40ss@h1:27017,h2:27017/db?replicaSet=rs0&tls=true';
    expect(uriOf(uri)).toBe(uri);
  });

  it('refuses a URI the driver cannot parse, and names the connection without the URI', () => {
    // The driver's parser rejects a URI with no host. The password must not reach the error.
    const secret = 'mongodb://user:hunter2@/';
    let caught: unknown;
    try {
      withoutInsecureTls(profile({ name: 'Broken', uri: secret }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppErrorException);
    const message = (caught as AppErrorException).error.message;
    expect(message).toContain('"Broken"');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain(secret);
  });

  it('forces allowInvalidCertificates off and keeps the other TLS settings', () => {
    const result = withoutInsecureTls(
      profile({
        tls: { enabled: true, allowInvalidCertificates: true, caFile: '/etc/ca.pem' },
      }),
    );
    expect(result.tls).toEqual({
      enabled: true,
      allowInvalidCertificates: false,
      caFile: '/etc/ca.pem',
    });
  });

  it('does not add a tls field to a profile that has none', () => {
    const result = withoutInsecureTls(profile({ uri: 'mongodb://h/?tlsInsecure=true' }));
    expect('tls' in result).toBe(false);
  });

  it('keeps the other profile fields', () => {
    const result = withoutInsecureTls(
      profile({ color: '#00aa00', production: true, readPreference: 'secondary' }),
    );
    expect(result).toMatchObject({
      id: '0b5c8a6e-2a4f-4c1e-9d3a-7f2e1b6c4d10',
      name: 'imported',
      color: '#00aa00',
      production: true,
      readPreference: 'secondary',
    });
  });
});
