import { describe, expect, it } from 'vitest';
import { AppErrorException } from '../domain/errors';
import {
  describeConnectionUri,
  parseConnectionsFile,
  planConnectionsImport,
} from './connections-file';

const validFile = {
  format: 'mongo-gui-connections',
  version: 1,
  kdf: {
    name: 'scrypt',
    N: 2 ** 17,
    r: 8,
    p: 1,
    salt: Buffer.alloc(32, 1).toString('base64'),
  },
  cipher: {
    name: 'aes-256-gcm',
    iv: Buffer.alloc(12, 2).toString('base64'),
    tag: Buffer.alloc(16, 3).toString('base64'),
  },
  payload: Buffer.from('ciphertext').toString('base64'),
};

function messageOf(value: unknown): string {
  try {
    parseConnectionsFile(value);
  } catch (error) {
    if (error instanceof AppErrorException) {
      return error.error.message;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('parseConnectionsFile', () => {
  it('accepts a well-formed envelope', () => {
    expect(parseConnectionsFile(validFile)).toEqual(validFile);
  });

  it('names the format when the file belongs to another tool', () => {
    expect(messageOf({ ...validFile, format: 'other' })).toBe(
      'This is not a Mongo GUI connections file.',
    );
  });

  it('names both versions when the version is unknown', () => {
    expect(messageOf({ ...validFile, version: 7 })).toBe(
      'This connections file has version 7. This app reads version 1.',
    );
  });

  it('caps the version text echoed in the message at 32 characters', () => {
    const long = 'v'.repeat(500);
    const message = messageOf({ ...validFile, version: long });
    expect(message).toBe(
      `This connections file has version ${'v'.repeat(32)}. This app reads version 1.`,
    );
  });

  it('refuses unknown fields and bad base64 with one generic message', () => {
    expect(messageOf({ ...validFile, extra: true })).toBe('The connections file is damaged.');
    expect(messageOf({ ...validFile, payload: 'not base64!' })).toBe(
      'The connections file is damaged.',
    );
    expect(
      messageOf({
        ...validFile,
        cipher: { ...validFile.cipher, iv: Buffer.alloc(11).toString('base64') },
      }),
    ).toBe('The connections file is damaged.');
  });

  it('refuses a non-object value', () => {
    expect(messageOf(['mongo-gui-connections'])).toBe('The connections file is damaged.');
  });
});

describe('describeConnectionUri', () => {
  it('never reports a host from inside a password that holds "/", "?" or "@"', () => {
    const cases: [string, string][] = [
      ['mongodb://usr:pa/ss@hostA:1/db', 'hostA:1'],
      ['mongodb://usr:pa?ss@hostA:1/db', 'hostA:1'],
      ['mongodb://usr:pa@ss@hostA:1/db', 'hostA:1'],
      ['mongodb://usr:pa/ss@hostA:1/db?authSource=a@b', 'hostA:1'],
      ['mongodb://usr:pa%2Fss%3Fx%40y@hostB:27017/db', 'hostB:27017'],
      ['mongodb+srv://usr:p%40ss@cluster.example/?retryWrites=true', 'cluster.example'],
    ];
    for (const [uri, host] of cases) {
      const summary = describeConnectionUri(uri);
      expect(summary.host).toBe(host);
      expect(summary.authKind).toBe('password');
      expect(summary.host).not.toMatch(/[@/?]/);
    }
  });

  it('reports the host for a URI without userinfo, even when an option holds "@"', () => {
    expect(describeConnectionUri('mongodb://hostD:27017/?authSource=a@b')).toEqual({
      host: 'hostD:27017',
      authKind: 'none',
    });
    expect(describeConnectionUri('mongodb://hostE')).toEqual({ host: 'hostE', authKind: 'none' });
  });

  it('reports the hosts and the auth kind without the credentials', () => {
    expect(
      describeConnectionUri('mongodb://app:s3cret@a.example:27017,b.example:27017/shop'),
    ).toEqual({ host: 'a.example:27017,b.example:27017', authKind: 'password' });
    expect(describeConnectionUri('mongodb://localhost:27017')).toEqual({
      host: 'localhost:27017',
      authKind: 'none',
    });
    expect(
      describeConnectionUri('mongodb+srv://cluster.example/?authMechanism=MONGODB-X509'),
    ).toEqual({ host: 'cluster.example', authKind: 'x509' });
  });
});

describe('planConnectionsImport', () => {
  const base = {
    uri: 'mongodb://localhost:27017',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const orders = { ...base, id: '0f1c4b7e-2d3a-4f5b-8c9d-1e2f3a4b5c6d', name: 'Orders' };
  const fresh = { ...base, id: '7a8b9c0d-1e2f-4a3b-9c8d-7e6f5a4b3c2d', name: 'Fresh' };
  const incoming = [orders, fresh];
  const existing = [{ id: '11111111-1111-4111-8111-111111111111', name: 'Orders' }];

  it('creates every connection that has no collision', () => {
    const plan = planConnectionsImport(incoming, [], 'skip');
    expect(plan.map((action) => action.kind)).toEqual(['create', 'create']);
    expect(plan[0]).toMatchObject({ kind: 'create', renamed: false });
    expect(plan[0]).not.toHaveProperty('input.id');
  });

  it('skips a colliding name in skip mode', () => {
    const plan = planConnectionsImport(incoming, existing, 'skip');
    expect(plan).toEqual([
      { kind: 'skip', name: 'Orders' },
      expect.objectContaining({
        kind: 'create',
        input: expect.objectContaining({ name: 'Fresh' }),
      }),
    ]);
  });

  it('renames a colliding name with the first free suffix in rename mode', () => {
    const plan = planConnectionsImport(
      incoming,
      [...existing, { id: '22222222-2222-4222-8222-222222222222', name: 'Orders (2)' }],
      'rename',
    );
    expect(plan[0]).toMatchObject({
      kind: 'create',
      renamed: true,
      input: { name: 'Orders (3)' },
    });
  });

  it('renames a name that repeats inside the file', () => {
    const plan = planConnectionsImport([fresh, fresh], [], 'rename');
    expect(
      plan.map((action) => (action.kind === 'create' ? action.input.name : action.kind)),
    ).toEqual(['Fresh', 'Fresh (2)']);
  });

  it('replaces the existing connection in replace mode', () => {
    const plan = planConnectionsImport(incoming, existing, 'replace');
    expect(plan[0]).toMatchObject({
      kind: 'replace',
      targetId: '11111111-1111-4111-8111-111111111111',
      input: { name: 'Orders' },
    });
  });

  it('replaces a target once: a second entry with the same name is renamed', () => {
    const plan = planConnectionsImport([orders, orders], existing, 'replace');
    expect(plan[0]).toMatchObject({
      kind: 'replace',
      targetId: '11111111-1111-4111-8111-111111111111',
    });
    expect(plan[1]).toMatchObject({ kind: 'create', renamed: true, input: { name: 'Orders (2)' } });
  });

  it('renames a repeat of a name created earlier in replace mode', () => {
    const plan = planConnectionsImport([fresh, fresh], [], 'replace');
    expect(plan[1]).toMatchObject({ kind: 'create', renamed: true });
  });
});
