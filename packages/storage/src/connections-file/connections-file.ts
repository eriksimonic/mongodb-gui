import { createCipheriv, randomBytes } from 'node:crypto';
import {
  CONNECTIONS_FILE_FORMAT,
  CONNECTIONS_FILE_VERSION,
  connectionsFileAad,
  assertConnectionsPassphrase,
  damagedFile,
  parseConnectionsFile,
  parseConnectionsPayload,
  AppErrorException,
  appError,
  type ConnectionProfile,
  type ConnectionsFile,
  type ScryptParams,
} from '@mongo-gui/core';
import { DEFAULT_KDF_PARAMS, deriveKek } from '../crypto/kdf';
import { DecryptError, open } from '../crypto/aead';

const SALT_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypts connection profiles, credentials included, into a connections file. The key comes from a
 * scrypt derivation of the passphrase with a fresh salt, and the IV is fresh too. The derived key
 * is zeroed before the function returns.
 */
export function exportConnections(
  profiles: readonly ConnectionProfile[],
  passphrase: string,
): Buffer {
  assertConnectionsPassphrase(passphrase);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const kdf: ScryptParams = {
    name: 'scrypt',
    ...DEFAULT_KDF_PARAMS,
    salt: salt.toString('base64'),
  };
  const cipherName = 'aes-256-gcm' as const;
  const aad = Buffer.from(
    connectionsFileAad({
      format: CONNECTIONS_FILE_FORMAT,
      version: CONNECTIONS_FILE_VERSION,
      kdf,
      cipher: { name: cipherName, iv: iv.toString('base64') },
    }),
    'utf8',
  );
  const key = deriveKek(passphrase, salt, DEFAULT_KDF_PARAMS);
  const plaintext = Buffer.from(JSON.stringify(profiles), 'utf8');
  try {
    const cipher = createCipheriv(cipherName, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const file: ConnectionsFile = {
      format: CONNECTIONS_FILE_FORMAT,
      version: CONNECTIONS_FILE_VERSION,
      kdf,
      cipher: {
        name: cipherName,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      },
      payload: body.toString('base64'),
    };
    return Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8');
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

/**
 * Decrypts a connections file. The AES-GCM tag is the only check on the passphrase, so a wrong
 * passphrase and a damaged file give the same message. The derived key is zeroed before return.
 */
export function importConnections(bytes: Buffer, passphrase: string): ConnectionProfile[] {
  assertConnectionsPassphrase(passphrase);
  const file = parseConnectionsFile(parseEnvelope(bytes));
  const salt = Buffer.from(file.kdf.salt, 'base64');
  const aad = Buffer.from(connectionsFileAad(file), 'utf8');
  const key = deriveKek(passphrase, salt, file.kdf);
  let plaintext: Buffer | undefined;
  try {
    const sealed = Buffer.concat([
      Buffer.from(file.cipher.iv, 'base64'),
      Buffer.from(file.payload, 'base64'),
      Buffer.from(file.cipher.tag, 'base64'),
    ]);
    plaintext = open(key, sealed, aad);
  } catch (error) {
    if (error instanceof DecryptError) {
      throw new AppErrorException(appError('VALIDATION', 'Wrong passphrase or damaged file.'));
    }
    throw error;
  } finally {
    key.fill(0);
  }
  try {
    return parseConnectionsPayload(parseJson(plaintext));
  } finally {
    plaintext.fill(0);
  }
}

function parseEnvelope(bytes: Buffer): unknown {
  return parseJson(bytes);
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw damagedFile();
  }
}
