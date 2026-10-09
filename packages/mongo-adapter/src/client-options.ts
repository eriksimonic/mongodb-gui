import type { ConnectionProfileInput } from '@mongo-gui/core';
import type { MongoClientOptions } from 'mongodb';

const DEFAULT_TIMEOUT_MS = 10_000;
const APP_NAME = 'mongo-gui';

type TlsProfile = NonNullable<ConnectionProfileInput['tls']>;

export interface ClientConfig {
  uri: string;
  options: MongoClientOptions;
}

export function buildClientOptions(profile: ConnectionProfileInput): ClientConfig {
  const options: Partial<MongoClientOptions> = {
    appName: APP_NAME,
    serverSelectionTimeoutMS: profile.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  if (profile.connectTimeoutMs !== undefined) {
    options.connectTimeoutMS = profile.connectTimeoutMs;
  }
  if (profile.readPreference !== undefined) {
    options.readPreference = profile.readPreference;
  }
  if (profile.tls !== undefined) {
    applyTls(options, profile.tls);
  }
  // The declaration build rejects a partially filled MongoClientOptions because the driver
  // types TLS socket fields as required. Every key set above is optional in the driver API.
  return { uri: profile.uri, options: options as MongoClientOptions };
}

function applyTls(options: Partial<MongoClientOptions>, tls: TlsProfile): void {
  options.tls = tls.enabled;
  if (!tls.enabled) {
    return;
  }
  if (tls.caFile !== undefined) {
    options.tlsCAFile = tls.caFile;
  }
  if (tls.certFile !== undefined) {
    options.tlsCertificateKeyFile = tls.certFile;
  }
  if (tls.allowInvalidCertificates !== undefined) {
    options.tlsAllowInvalidCertificates = tls.allowInvalidCertificates;
  }
}
