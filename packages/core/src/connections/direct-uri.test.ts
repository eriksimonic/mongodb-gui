import { describe, expect, it } from 'vitest';
import { directConnectionName, directUriFor } from './direct-uri';

describe('directUriFor', () => {
  it('replaces the host list, drops replicaSet and sets directConnection', () => {
    expect(
      directUriFor(
        'mongodb://admin:p%40ss@a:27117,b:27118,c:27119/admin?replicaSet=rs0&authSource=admin',
        'b:27118',
      ),
    ).toBe('mongodb://admin:p%40ss@b:27118/admin?authSource=admin&directConnection=true');
  });

  it('keeps a URI without user info, path or options', () => {
    expect(directUriFor('mongodb://a:27017,b:27017', 'a:27017')).toBe(
      'mongodb://a:27017/?directConnection=true',
    );
  });

  it('replaces an existing directConnection option instead of doubling it', () => {
    expect(directUriFor('mongodb://a:1/?directConnection=false&w=majority', 'a:1')).toBe(
      'mongodb://a:1/?w=majority&directConnection=true',
    );
  });

  it('turns an SRV URI into a plain URI to the member', () => {
    expect(
      directUriFor('mongodb+srv://u:p@cluster.example.net/db?tls=true', 'm1.example.net:27017'),
    ).toBe('mongodb://u:p@m1.example.net:27017/db?tls=true&directConnection=true');
  });

  it('refuses text that is not a MongoDB URI', () => {
    expect(() => directUriFor('postgres://x', 'a:1')).toThrow('Not a MongoDB URI');
  });

  it('names the derived profile after the parent and the host', () => {
    expect(directConnectionName('Perf', 'b:27118')).toBe('Perf · b:27118');
  });
});
