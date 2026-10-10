import { describe, expect, it } from 'vitest';
import { toolsUri, uriHosts, uriWithoutCredentials } from './tools-uri';

const DOCKER_URI = 'mongodb://user:p%40ss@127.0.0.1:49152/?directConnection=true&authSource=admin';

describe('toolsUri', () => {
  it('leaves a plain URI as it is', () => {
    expect(toolsUri({ uri: 'mongodb://localhost:27017' })).toBe('mongodb://localhost:27017/');
  });

  it('moves a database in the path to authSource', () => {
    expect(toolsUri({ uri: 'mongodb://u:p@db.example.com/shop?retryWrites=true' })).toBe(
      'mongodb://u:p@db.example.com/?retryWrites=true&authSource=shop',
    );
  });

  it('keeps an existing authSource and still removes the path', () => {
    expect(toolsUri({ uri: 'mongodb://u:p@h/shop?AuthSource=admin' })).toBe(
      'mongodb://u:p@h/?AuthSource=admin',
    );
  });

  it('keeps the Docker forwarder URI with its credentials and options', () => {
    expect(toolsUri({ uri: DOCKER_URI })).toBe(DOCKER_URI);
  });

  it('keeps SRV, replica set and direct connection options', () => {
    expect(toolsUri({ uri: 'mongodb+srv://u:p@cluster0.abc.mongodb.net/app?w=majority' })).toBe(
      'mongodb+srv://u:p@cluster0.abc.mongodb.net/?w=majority&authSource=app',
    );
    expect(toolsUri({ uri: 'mongodb://a:27017,b:27018,c:27019/?replicaSet=rs0' })).toBe(
      'mongodb://a:27017,b:27018,c:27019/?replicaSet=rs0',
    );
  });

  it('keeps an IPv6 host', () => {
    expect(toolsUri({ uri: 'mongodb://u:p@[::1]:27017/shop' })).toBe(
      'mongodb://u:p@[::1]:27017/?authSource=shop',
    );
  });

  it('takes the read preference from the override, then the profile', () => {
    const uri = 'mongodb://h/?readpreference=nearest';
    expect(toolsUri({ uri })).toBe(uri);
    expect(toolsUri({ uri, readPreference: 'secondary' })).toBe(
      'mongodb://h/?readPreference=secondary',
    );
    expect(toolsUri({ uri, readPreference: 'secondary' }, { readPreference: 'primary' })).toBe(
      'mongodb://h/?readPreference=primary',
    );
  });

  it('folds TLS settings into the query with percent-encoded paths', () => {
    const uri = toolsUri({
      uri: 'mongodb://h/?ssl=false&sslCA=/old.pem&TLSINSECURE=false',
      tls: {
        enabled: true,
        caFile: '/home/me/My Certs/ca.pem',
        certFile: 'C:\\Users\\me\\client key.pem',
        allowInvalidCertificates: true,
      },
    });
    expect(uri).toBe(
      'mongodb://h/?tls=true&tlsCAFile=%2Fhome%2Fme%2FMy%20Certs%2Fca.pem' +
        '&tlsCertificateKeyFile=C%3A%5CUsers%5Cme%5Cclient%20key.pem&tlsInsecure=true',
    );
  });

  it('turns TLS off when the profile does, and ignores its files', () => {
    expect(
      toolsUri({ uri: 'mongodb://h/?tls=true', tls: { enabled: false, caFile: '/ca.pem' } }),
    ).toBe('mongodb://h/?tls=false');
  });

  it('adds the connect timeout unless the URI has one', () => {
    expect(toolsUri({ uri: 'mongodb://h', connectTimeoutMs: 5000 })).toBe(
      'mongodb://h/?connectTimeoutMS=5000',
    );
    expect(toolsUri({ uri: 'mongodb://h/?connecttimeoutms=100', connectTimeoutMs: 5000 })).toBe(
      'mongodb://h/?connecttimeoutms=100',
    );
  });

  it('keeps AWS mechanism properties for the tools', () => {
    const uri =
      'mongodb://AKIA:secret@h/?authMechanism=MONGODB-AWS&authMechanismProperties=AWS_SESSION_TOKEN:tok%2Ben';
    expect(toolsUri({ uri })).toBe(uri);
  });

  it('refuses a URI that is not a MongoDB URI', () => {
    expect(() => toolsUri({ uri: 'http://h' })).toThrow('Not a MongoDB URI');
  });
});

describe('uriWithoutCredentials', () => {
  it('drops user info, the AWS token and the key password', () => {
    const uri = uriWithoutCredentials(
      'mongodb://AKIA:s3cret@h1:27017,h2:27018/shop?replicaSet=rs0&authMechanism=MONGODB-AWS' +
        '&authMechanismProperties=AWS_SESSION_TOKEN:tok3n&tlsCertificateKeyFilePassword=kp4ss' +
        '&tlsCAFile=%2Fca.pem&tls=true&appName=gui',
    );
    expect(uri).toBe(
      'mongodb://h1:27017,h2:27018/shop?replicaSet=rs0&authMechanism=MONGODB-AWS&tls=true&appName=gui',
    );
    for (const secret of ['AKIA', 's3cret', 'tok3n', 'kp4ss', 'ca.pem']) {
      expect(uri).not.toContain(secret);
    }
  });

  it('drops the Docker forwarder password', () => {
    expect(uriWithoutCredentials(DOCKER_URI)).toBe(
      'mongodb://127.0.0.1:49152/?directConnection=true&authSource=admin',
    );
  });

  it('keeps an SRV scheme', () => {
    expect(uriWithoutCredentials('mongodb+srv://u:p@cluster0.abc.mongodb.net/')).toBe(
      'mongodb+srv://cluster0.abc.mongodb.net/',
    );
  });
});

describe('uriHosts', () => {
  it('lists hosts with ports', () => {
    expect(uriHosts('mongodb://u:p@a,b:27018,[::1],[fe80::1]:27019/x')).toEqual([
      'a:27017',
      'b:27018',
      '[::1]:27017',
      '[fe80::1]:27019',
    ]);
  });

  it('gives the SRV name', () => {
    expect(uriHosts('mongodb+srv://u:p@cluster0.abc.mongodb.net/?tls=true')).toEqual([
      'cluster0.abc.mongodb.net',
    ]);
  });

  it('gives the Docker forwarder', () => {
    expect(uriHosts(DOCKER_URI)).toEqual(['127.0.0.1:49152']);
  });
});
