import { describe, expect, it } from 'vitest';
import { userConnectionString } from './connection-string';

const connected = {
  state: 'connected' as const,
  serverVersion: '7.0.3',
  topology: 'replicaSet' as const,
};

describe('userConnectionString', () => {
  it('names the set and every host of a replica set connection', () => {
    expect(
      userConnectionString(
        { user: 'reporter', db: 'shop' },
        { ...connected, setName: 'rs0', hosts: ['a:27117', 'b:27118'] },
      ),
    ).toBe('mongodb://reporter:<password>@a:27117,b:27118/?authSource=shop&replicaSet=rs0');
  });

  it('keeps a direct connection direct and drops the set name', () => {
    expect(
      userConnectionString(
        { user: 'admin', db: 'admin' },
        { ...connected, setName: 'rs0', hosts: ['a:27117'], directConnection: true },
      ),
    ).toBe('mongodb://admin:<password>@a:27117/?authSource=admin&directConnection=true');
  });

  it('encodes the user name and the external auth source', () => {
    expect(
      userConnectionString(
        { user: 'CN=app,O=acme', db: '$external' },
        { ...connected, topology: 'standalone', hosts: ['h:1'] },
      ),
    ).toBe('mongodb://CN%3Dapp%2CO%3Dacme:<password>@h:1/?authSource=%24external');
  });

  it('falls back to localhost when the connection is not open', () => {
    expect(userConnectionString({ user: 'u', db: 'admin' }, undefined)).toBe(
      'mongodb://u:<password>@localhost:27017/?authSource=admin',
    );
  });
});
