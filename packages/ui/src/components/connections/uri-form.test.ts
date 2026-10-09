import { describe, expect, it } from 'vitest';
import {
  buildMongoUri,
  emptyUriForm,
  parseMongoUri,
  profileOptionsFromUri,
  validateUriForm,
  type UriForm,
} from './uri-form';

function parsed(uri: string): UriForm {
  const result = parseMongoUri(uri);
  if (!result.ok) {
    throw new Error(`expected ${uri} to parse: ${result.message}`);
  }
  return result.form;
}

describe('parseMongoUri and buildMongoUri', () => {
  it('round trips a standard URI with credentials and auth source', () => {
    const uri = 'mongodb://app:secret@localhost:27017/?authSource=admin';
    expect(buildMongoUri(parsed(uri))).toBe(uri);
  });

  it('reads the fields of a standard URI', () => {
    const form = parsed('mongodb://app:secret@db1:27017,db2:27017/shop?authSource=admin');
    expect(form.scheme).toBe('mongodb');
    expect(form.hosts).toEqual(['db1:27017', 'db2:27017']);
    expect(form.username).toBe('app');
    expect(form.password).toBe('secret');
    expect(form.database).toBe('shop');
    expect(form.authSource).toBe('admin');
  });

  it('round trips an SRV URI without a port', () => {
    const uri = 'mongodb+srv://cluster0.example.net/?retryWrites=true';
    const form = parsed(uri);
    expect(form.scheme).toBe('mongodb+srv');
    expect(form.hosts).toEqual(['cluster0.example.net']);
    expect(buildMongoUri(form)).toBe(uri);
  });

  it('percent-encodes special characters in the password and parses them back', () => {
    const form: UriForm = { ...emptyUriForm(), username: 'ops@team', password: 'p@ss:w/rd%#?' };
    const uri = buildMongoUri(form);
    expect(uri).toBe('mongodb://ops%40team:p%40ss%3Aw%2Frd%25%23%3F@localhost:27017/');
    expect(parsed(uri)).toEqual(form);
  });

  it('keeps options the form does not know and writes them back', () => {
    const uri = 'mongodb://localhost:27017/?appName=reports&retryWrites=false';
    const form = parsed(uri);
    expect(form.extraOptions).toEqual([
      ['appName', 'reports'],
      ['retryWrites', 'false'],
    ]);
    expect(buildMongoUri(form)).toBe(uri);
  });

  it('reads TLS, read preference, replica set and timeout options', () => {
    const uri =
      'mongodb://localhost:27017/?replicaSet=rs0&readPreference=secondaryPreferred&connectTimeoutMS=5000&tls=true&tlsCAFile=%2Fetc%2Fca.pem&tlsCertificateKeyFile=%2Fetc%2Fclient.pem&tlsAllowInvalidCertificates=true';
    const form = parsed(uri);
    expect(form.replicaSet).toBe('rs0');
    expect(form.readPreference).toBe('secondaryPreferred');
    expect(form.connectTimeoutMs).toBe(5000);
    expect(form.tls).toEqual({
      enabled: true,
      caFile: '/etc/ca.pem',
      certFile: '/etc/client.pem',
      allowInvalidCertificates: true,
    });
    expect(buildMongoUri(form)).toBe(uri);
  });

  it('keeps a connect timeout that is not a positive integer as an extra option', () => {
    const form = parsed('mongodb://localhost/?connectTimeoutMS=soon');
    expect(form.connectTimeoutMs).toBeUndefined();
    expect(form.extraOptions).toEqual([['connectTimeoutMS', 'soon']]);
  });

  it('matches option names case-insensitively and reads explicit TLS flags', () => {
    const form = parsed('mongodb://localhost/?authsource=admin&TLS=false&ssl=true');
    expect(form.authSource).toBe('admin');
    expect(form.tls.enabled).toBe(true);
    expect(form.extraOptions).toEqual([]);
    expect(buildMongoUri(form)).toBe('mongodb://localhost/?authSource=admin&tls=true');
  });

  it('treats tls=false on its own as TLS off and writes nothing for it', () => {
    const form = parsed('mongodb://localhost/?TLS=false');
    expect(form.tls.enabled).toBe(false);
    expect(form.extraOptions).toEqual([]);
    expect(buildMongoUri(form)).toBe('mongodb://localhost/');
  });

  it('never writes an option twice when the URI names it under two spellings', () => {
    const form = parsed('mongodb://localhost/?tls=true&ssl=true&authsource=a&authSource=b');
    expect(form.tls.enabled).toBe(true);
    const uri = buildMongoUri(form);
    expect(uri.match(/tls=/g)).toHaveLength(1);
    expect(uri.match(/authSource=/g)).toHaveLength(1);
  });

  it('reads lower-case replicaset, readpreference and connecttimeoutms', () => {
    const form = parsed(
      'mongodb://localhost/?replicaset=rs1&readpreference=nearest&connecttimeoutms=900',
    );
    expect(form.replicaSet).toBe('rs1');
    expect(form.readPreference).toBe('nearest');
    expect(form.connectTimeoutMs).toBe(900);
  });

  it('rejects a string that is not a mongo URI', () => {
    expect(parseMongoUri('postgres://localhost')).toEqual({
      ok: false,
      message: 'The URI must start with mongodb:// or mongodb+srv://.',
    });
  });

  it('rejects a URI with broken percent-encoding', () => {
    expect(parseMongoUri('mongodb://app:%zz@localhost/').ok).toBe(false);
  });

  it('drops blank host entries when building', () => {
    const form: UriForm = { ...emptyUriForm(), hosts: ['a:27017', '  ', ''] };
    expect(buildMongoUri(form)).toBe('mongodb://a:27017/');
  });
});

describe('validateUriForm', () => {
  it('asks for at least one host', () => {
    expect(validateUriForm({ ...emptyUriForm(), hosts: [] })).toBe('Add at least one host.');
  });

  it('allows only one host for an SRV URI', () => {
    const form: UriForm = {
      ...emptyUriForm(),
      scheme: 'mongodb+srv',
      hosts: ['a.example.net', 'b.example.net'],
    };
    expect(validateUriForm(form)).toBe('A mongodb+srv URI takes exactly one host name.');
  });

  it('rejects a port on an SRV host', () => {
    const form: UriForm = {
      ...emptyUriForm(),
      scheme: 'mongodb+srv',
      hosts: ['a.example.net:27017'],
    };
    expect(validateUriForm(form)).toBe('A mongodb+srv host name cannot include a port.');
  });

  it('accepts an SRV host without a port', () => {
    const form: UriForm = { ...emptyUriForm(), scheme: 'mongodb+srv', hosts: ['a.example.net'] };
    expect(validateUriForm(form)).toBeUndefined();
  });

  it('requires a user name when a password is set', () => {
    expect(validateUriForm({ ...emptyUriForm(), password: 'secret' })).toBe(
      'A password needs a user name.',
    );
  });
});

describe('profileOptionsFromUri', () => {
  it('returns the TLS, read preference and timeout options of a URI', () => {
    expect(
      profileOptionsFromUri(
        'mongodb://localhost/?tls=true&readPreference=primary&connectTimeoutMS=2000',
      ),
    ).toEqual({
      tls: { enabled: true },
      readPreference: 'primary',
      connectTimeoutMs: 2000,
    });
  });

  it('returns no options for a URI without them', () => {
    expect(profileOptionsFromUri('mongodb://localhost/')).toEqual({});
  });

  it('returns no options for a URI that does not parse', () => {
    expect(profileOptionsFromUri('nonsense')).toEqual({});
  });
});
