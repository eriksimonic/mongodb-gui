import { describe, expect, it } from 'vitest';
import {
  ConnectionProfileInputSchema,
  ConnectionProfileSchema,
  ConnectionProfileSummarySchema,
  ConnectionStatusSchema,
  ConnectionTestResultSchema,
} from './connection';

const profile = {
  id: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10',
  name: 'Local',
  color: '#3b82f6',
  uri: 'mongodb://app:secret@localhost:27017/?authSource=admin',
  tls: { enabled: true, caFile: '/etc/ssl/ca.pem' },
  readPreference: 'secondaryPreferred',
  connectTimeoutMs: 5000,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T11:30:00.000Z',
} as const;

describe('ConnectionProfileSchema', () => {
  it('accepts a complete profile', () => {
    expect(ConnectionProfileSchema.safeParse(profile).success).toBe(true);
  });

  it('accepts a profile with only the required fields', () => {
    const minimal = {
      id: profile.id,
      name: profile.name,
      uri: profile.uri,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
    expect(ConnectionProfileSchema.safeParse(minimal).success).toBe(true);
  });

  it('rejects a mongo uri with no characters after the scheme', () => {
    expect(ConnectionProfileSchema.safeParse({ ...profile, uri: 'mongodb://' }).success).toBe(
      false,
    );
  });

  it('rejects a uri without a mongo scheme', () => {
    const result = ConnectionProfileSchema.safeParse({
      ...profile,
      uri: 'postgres://localhost:5432',
    });
    expect(result.success).toBe(false);
  });
});

describe('ConnectionProfileInputSchema', () => {
  it('accepts input without id and timestamps', () => {
    const input = { name: profile.name, uri: profile.uri, tls: profile.tls };
    expect(ConnectionProfileInputSchema.safeParse(input).success).toBe(true);
  });

  it('rejects input without a name', () => {
    expect(ConnectionProfileInputSchema.safeParse({ uri: profile.uri }).success).toBe(false);
  });
});

describe('ConnectionProfileSummarySchema', () => {
  it('accepts a summary with uriRedacted and no uri', () => {
    const summary = {
      id: profile.id,
      name: profile.name,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      uriRedacted: 'mongodb://app:***@localhost:27017/',
    };
    expect(ConnectionProfileSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('drops the full uri from parsed output', () => {
    const result = ConnectionProfileSummarySchema.safeParse({
      ...profile,
      uriRedacted: 'mongodb://app:***@localhost:27017/',
    });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('uri');
  });

  it('rejects a summary without uriRedacted', () => {
    expect(ConnectionProfileSummarySchema.safeParse(profile).success).toBe(false);
  });
});

describe('ConnectionStatusSchema', () => {
  it('accepts a connected status', () => {
    const status = {
      state: 'connected',
      serverVersion: '8.0.4',
      topology: 'replicaSet',
      setName: 'rs0',
      hosts: ['a:27017', 'b:27017'],
    };
    expect(ConnectionStatusSchema.safeParse(status).success).toBe(true);
  });

  it('accepts an error status carrying an AppError', () => {
    const status = {
      state: 'error',
      error: { code: 'AUTH_FAILED', message: 'Authentication failed' },
    };
    expect(ConnectionStatusSchema.safeParse(status).success).toBe(true);
  });

  it('rejects an unknown state', () => {
    expect(ConnectionStatusSchema.safeParse({ state: 'paused' }).success).toBe(false);
  });
});

describe('ConnectionTestResultSchema', () => {
  it('accepts a successful and a failed test result', () => {
    const ok = { ok: true, serverVersion: '6.0.14', topology: 'standalone' };
    const failed = { ok: false, error: { code: 'CONNECTION_FAILED', message: 'Refused' } };
    expect(ConnectionTestResultSchema.safeParse(ok).success).toBe(true);
    expect(ConnectionTestResultSchema.safeParse(failed).success).toBe(true);
  });

  it('rejects a successful result without a server version', () => {
    expect(ConnectionTestResultSchema.safeParse({ ok: true, topology: 'standalone' }).success).toBe(
      false,
    );
  });
});
