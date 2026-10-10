import { describe, expect, it } from 'vitest';
import { AppErrorException, type ConnectionProfile } from '@mongo-gui/core';
import { exportConnections, importConnections } from './connections-file';

const PASSPHRASE = 'export passphrase 1';
const WRONG = 'another passphrase';
// The lowest cost a connections file accepts. A derivation at the default cost takes 128 MiB and
// about 150 ms on a fast idle machine, and this file derives 16 keys. Only the envelope test needs
// the default cost.
const CHEAP_KDF = { N: 2 ** 14, r: 8, p: 1 };

const profiles: ConnectionProfile[] = [
  {
    id: '0f1c4b7e-2d3a-4f5b-8c9d-1e2f3a4b5c6d',
    name: 'Orders',
    uri: 'mongodb://app:s3cret@db.example.com:27017/shop',
    readPreference: 'secondary',
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
  },
  {
    id: '7a8b9c0d-1e2f-4a3b-9c8d-7e6f5a4b3c2d',
    name: 'Local',
    uri: 'mongodb://localhost:27017',
    createdAt: '2026-02-03T04:05:06.000Z',
    updatedAt: '2026-02-03T04:05:06.000Z',
  },
];

function envelope(bytes: Buffer): Record<string, unknown> {
  return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
}

function rewrite(bytes: Buffer, change: (file: Record<string, unknown>) => void): Buffer {
  const file = envelope(bytes);
  change(file);
  return Buffer.from(JSON.stringify(file), 'utf8');
}

function messageOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof AppErrorException) {
      return error.error.message;
    }
    throw error;
  }
  throw new Error('expected an error');
}

describe('connections file', () => {
  it('round trips the profiles, credentials included', () => {
    const bytes = exportConnections(profiles, PASSPHRASE, CHEAP_KDF);
    expect(importConnections(bytes, PASSPHRASE)).toEqual(profiles);
    expect(bytes.toString('utf8')).not.toContain('s3cret');
  });

  it('writes the documented envelope', () => {
    const file = envelope(exportConnections(profiles, PASSPHRASE));
    expect(file).toMatchObject({
      format: 'mongo-gui-connections',
      version: 1,
      kdf: { name: 'scrypt', N: 2 ** 17, r: 8, p: 1 },
      cipher: { name: 'aes-256-gcm' },
    });
    expect(Object.keys(file).sort()).toEqual(['cipher', 'format', 'kdf', 'payload', 'version']);
  });

  it('uses a fresh salt and IV for every export', () => {
    const first = envelope(exportConnections(profiles, PASSPHRASE, CHEAP_KDF));
    const second = envelope(exportConnections(profiles, PASSPHRASE, CHEAP_KDF));
    expect((first.kdf as { salt: string }).salt).not.toBe((second.kdf as { salt: string }).salt);
    expect((first.cipher as { iv: string }).iv).not.toBe((second.cipher as { iv: string }).iv);
    expect(first.payload).not.toBe(second.payload);
  });

  it('refuses a wrong passphrase with the damaged-file message', () => {
    const bytes = exportConnections(profiles, PASSPHRASE, CHEAP_KDF);
    expect(messageOf(() => importConnections(bytes, WRONG))).toBe(
      'Wrong passphrase or damaged file.',
    );
  });

  it('refuses a tampered payload byte', () => {
    const bytes = exportConnections(profiles, PASSPHRASE, CHEAP_KDF);
    const tampered = rewrite(bytes, (file) => {
      const payload = Buffer.from(file.payload as string, 'base64');
      payload[0] = (payload[0] ?? 0) ^ 0x01;
      file.payload = payload.toString('base64');
    });
    expect(messageOf(() => importConnections(tampered, PASSPHRASE))).toBe(
      'Wrong passphrase or damaged file.',
    );
  });

  it('refuses a changed header field because the header is authenticated', () => {
    const bytes = exportConnections(profiles, PASSPHRASE, CHEAP_KDF);
    const tampered = rewrite(bytes, (file) => {
      const kdf = file.kdf as { salt: string };
      const salt = Buffer.from(kdf.salt, 'base64');
      salt[0] = (salt[0] ?? 0) ^ 0x01;
      kdf.salt = salt.toString('base64');
    });
    expect(messageOf(() => importConnections(tampered, PASSPHRASE))).toBe(
      'Wrong passphrase or damaged file.',
    );
  });

  it('refuses an unknown version with a message that names both versions', () => {
    const bytes = exportConnections(profiles, PASSPHRASE, CHEAP_KDF);
    const future = rewrite(bytes, (file) => {
      file.version = 2;
    });
    expect(messageOf(() => importConnections(future, PASSPHRASE))).toBe(
      'This connections file has version 2. This app reads version 1.',
    );
  });

  it('refuses a file with another format', () => {
    const bytes = exportConnections(profiles, PASSPHRASE, CHEAP_KDF);
    const other = rewrite(bytes, (file) => {
      file.format = 'mongo-gui-backup';
    });
    expect(messageOf(() => importConnections(other, PASSPHRASE))).toBe(
      'This is not a Mongo GUI connections file.',
    );
  });

  it('refuses a truncated file as damaged', () => {
    const bytes = exportConnections(profiles, PASSPHRASE, CHEAP_KDF);
    const truncated = bytes.subarray(0, Math.floor(bytes.length / 2));
    expect(messageOf(() => importConnections(truncated, PASSPHRASE))).toBe(
      'The connections file is damaged.',
    );
  });

  it('refuses a scrypt cost above the bound before deriving a key', () => {
    const bytes = exportConnections(profiles, PASSPHRASE, CHEAP_KDF);
    const expensive = rewrite(bytes, (file) => {
      (file.kdf as { N: number }).N = 2 ** 30;
    });
    expect(messageOf(() => importConnections(expensive, PASSPHRASE))).toBe(
      'The connections file is damaged.',
    );
  });

  it('refuses a passphrase under ten characters without echoing it', () => {
    const short = 'short 9ch';
    expect(messageOf(() => exportConnections(profiles, short))).toBe(
      'The passphrase must be at least 10 characters.',
    );
    const bytes = exportConnections(profiles, PASSPHRASE, CHEAP_KDF);
    expect(messageOf(() => importConnections(bytes, short))).not.toContain(short);
  });
});
