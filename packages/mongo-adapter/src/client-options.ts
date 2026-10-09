import type { ConnectionProfileInput } from '@mongo-gui/core';
import type { MongoClientOptions } from 'mongodb';

const DEFAULT_TIMEOUT_MS = 10_000;
const APP_NAME = 'mongo-gui';

type TlsProfile = NonNullable<ConnectionProfileInput['tls']>;

export function buildClientOptions(profile: ConnectionProfileInput): {
  uri: string;
  options: MongoClientOptions;
} {
  // The driver types its TLS socket fields as required under exactOptionalPropertyTypes,
  // so a partially filled options object cannot satisfy MongoClientOptions without a cast.
  const options: Partial<MongoClientOptions> = {
    appName: APP_NAME,
    serverSelectionTimeoutMS: profile.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...connectTimeoutOptions(profile.connectTimeoutMs),
    ...readPreferenceOptions(profile.readPreference),
    ...tlsOptions(profile.tls),
  };
  return { uri: profile.uri, options: options as MongoClientOptions };
}

function connectTimeoutOptions(timeoutMs: number | undefined): Partial<MongoClientOptions> {
  return timeoutMs === undefined ? {} : { connectTimeoutMS: timeoutMs };
}

function readPreferenceOptions(
  mode: ConnectionProfileInput['readPreference'],
): Partial<MongoClientOptions> {
  return mode === undefined ? {} : { readPreference: mode };
}

function tlsOptions(tls: TlsProfile | undefined): Partial<MongoClientOptions> {
  if (tls === undefined) {
    return {};
  }
  if (!tls.enabled) {
    return { tls: false };
  }
  return {
    tls: true,
    ...(tls.caFile === undefined ? {} : { tlsCAFile: tls.caFile }),
    ...(tls.certFile === undefined ? {} : { tlsCertificateKeyFile: tls.certFile }),
    ...(tls.allowInvalidCertificates === undefined
      ? {}
      : { tlsAllowInvalidCertificates: tls.allowInvalidCertificates }),
  };
}
