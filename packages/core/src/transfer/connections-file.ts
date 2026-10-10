import { z } from 'zod';
import { AppErrorException, appError } from '../domain/errors';
import { ConnectionProfileInputSchema, ConnectionProfileSchema } from '../schemas/connection';
import type { ConnectionProfile, ConnectionProfileInput } from '../domain/connection';
import { AbsolutePathSchema } from './types';
import { userInfoEnd } from '../redact';

export const CONNECTIONS_FILE_FORMAT = 'mongo-gui-connections';
export const CONNECTIONS_FILE_VERSION = 1;
export const CONNECTIONS_PASSPHRASE_MIN_LENGTH = 10;
export const CONNECTIONS_PASSPHRASE_MAX_LENGTH = 1024;

/** Largest connections file the app reads. A file of a few hundred connections is far below it. */
export const CONNECTIONS_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const CONNECTIONS_EXPORT_MAX_PROFILES = 1000;

// Bounds on the scrypt cost a file may ask for. A file outside them is refused before any key derivation.
const SCRYPT_MIN_N = 2 ** 14;
const SCRYPT_MAX_N = 2 ** 20;
const SCRYPT_MAX_R = 16;
const SCRYPT_MAX_P = 4;
// OpenSSL allocates 128 * r * (N + 2 + p) bytes for scrypt.
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;
const SALT_BYTES = 32;
const VERSION_TEXT_MAX = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The number of bytes a base64 text decodes to, or undefined when the text is not base64. */
function base64ByteLength(text: string): number | undefined {
  if (!BASE64_PATTERN.test(text)) {
    return undefined;
  }
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

/** Accepts base64 that decodes to exactly `bytes` bytes. Core has no Buffer, so the length is computed. */
function base64Of(bytes: number): z.ZodString {
  return z.string().refine((text) => base64ByteLength(text) === bytes);
}

/** Any base64 text, such as the ciphertext. */
const anyBase64 = z.string().refine((text) => base64ByteLength(text) !== undefined);

export const ScryptParamsSchema = z
  .object({
    name: z.literal('scrypt'),
    N: z
      .number()
      .int()
      .min(SCRYPT_MIN_N)
      .max(SCRYPT_MAX_N)
      .refine((n) => (n & (n - 1)) === 0, 'N must be a power of two'),
    r: z.number().int().min(1).max(SCRYPT_MAX_R),
    p: z.number().int().min(1).max(SCRYPT_MAX_P),
    salt: base64Of(SALT_BYTES),
  })
  .strict()
  .refine(
    (kdf) => 128 * kdf.r * (kdf.N + 2 + kdf.p) <= SCRYPT_MAX_MEMORY,
    'scrypt cost is too high',
  );

export const AesGcmParamsSchema = z
  .object({
    name: z.literal('aes-256-gcm'),
    iv: base64Of(IV_BYTES),
    tag: base64Of(TAG_BYTES),
  })
  .strict();

/** The envelope written to disk. The header fields are authenticated; see connectionsFileAad. */
export const ConnectionsFileSchema = z
  .object({
    format: z.literal(CONNECTIONS_FILE_FORMAT),
    version: z.literal(CONNECTIONS_FILE_VERSION),
    kdf: ScryptParamsSchema,
    cipher: AesGcmParamsSchema,
    payload: anyBase64,
  })
  .strict();

export type ConnectionsFile = z.infer<typeof ConnectionsFileSchema>;
export type ScryptParams = z.infer<typeof ScryptParamsSchema>;

/** The header fields that the AES-GCM authenticated data covers. The tag is the output, so it is not one. */
export interface ConnectionsFileHeader {
  readonly format: typeof CONNECTIONS_FILE_FORMAT;
  readonly version: typeof CONNECTIONS_FILE_VERSION;
  readonly kdf: ScryptParams;
  readonly cipher: { readonly name: 'aes-256-gcm'; readonly iv: string };
}

/**
 * The authenticated data for a file: the format, the version, the scrypt parameters and the IV.
 * The fields are written in a fixed order, so the same header always gives the same bytes.
 */
export function connectionsFileAad(header: ConnectionsFileHeader): string {
  return JSON.stringify({
    format: header.format,
    version: header.version,
    kdf: {
      name: header.kdf.name,
      N: header.kdf.N,
      r: header.kdf.r,
      p: header.kdf.p,
      salt: header.kdf.salt,
    },
    cipher: { name: header.cipher.name, iv: header.cipher.iv },
  });
}

/** The decrypted payload: full connection profiles, credentials included. */
export const ConnectionsPayloadSchema = z.array(ConnectionProfileSchema);

/**
 * Validates a parsed connections file. A wrong format or version gets its own message, so the user
 * learns what the file is. Any other mismatch gets one generic message and no zod detail.
 */
export function parseConnectionsFile(value: unknown): ConnectionsFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw damagedFile();
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record.format !== CONNECTIONS_FILE_FORMAT) {
    throw new AppErrorException(
      appError('VALIDATION', 'This is not a Mongo GUI connections file.'),
    );
  }
  if (record.version !== CONNECTIONS_FILE_VERSION) {
    // The file's own value is echoed, so it is capped to keep a hostile file from filling the error.
    const shown = String(record.version).slice(0, VERSION_TEXT_MAX);
    throw new AppErrorException(
      appError(
        'VALIDATION',
        `This connections file has version ${shown}. This app reads version ${CONNECTIONS_FILE_VERSION}.`,
      ),
    );
  }
  const result = ConnectionsFileSchema.safeParse(value);
  if (!result.success) {
    throw damagedFile();
  }
  return result.data;
}

/** Validates the decrypted payload. Only an authenticated file reaches this check. */
export function parseConnectionsPayload(value: unknown): z.infer<typeof ConnectionsPayloadSchema> {
  const result = ConnectionsPayloadSchema.safeParse(value);
  if (!result.success) {
    throw damagedFile();
  }
  return result.data;
}

/** Refuses a passphrase outside the length rule. The message never includes the passphrase. */
export function assertConnectionsPassphrase(passphrase: string): void {
  if (passphrase.length < CONNECTIONS_PASSPHRASE_MIN_LENGTH) {
    throw new AppErrorException(
      appError(
        'VALIDATION',
        `The passphrase must be at least ${CONNECTIONS_PASSPHRASE_MIN_LENGTH} characters.`,
      ),
    );
  }
}

export function damagedFile(): AppErrorException {
  return new AppErrorException(appError('VALIDATION', 'The connections file is damaged.'));
}

/** The host and the auth kind of a connection, for the import preview. The URI never leaves as text. */
export interface ConnectionSummaryLine {
  readonly name: string;
  readonly host: string;
  readonly authKind: 'none' | 'password' | 'x509' | 'other';
}

const SCHEME = /^mongodb(\+srv)?:\/\//i;

export function describeConnectionUri(
  uri: string,
): Pick<ConnectionSummaryLine, 'host' | 'authKind'> {
  const rest = uri.replace(SCHEME, '');
  const at = userInfoEnd(rest);
  const userInfo = at === -1 ? undefined : rest.slice(0, at);
  // The host starts after the userinfo, so no part of a password can reach it.
  const afterUserInfo = at === -1 ? rest : rest.slice(at + 1);
  const hostEnd = afterUserInfo.search(/[/?]/);
  const host = hostEnd === -1 ? afterUserInfo : afterUserInfo.slice(0, hostEnd);
  const x509 = /authMechanism=MONGODB-X509/i.test(rest);
  let authKind: ConnectionSummaryLine['authKind'] = 'none';
  if (x509) {
    authKind = 'x509';
  } else if (userInfo !== undefined && userInfo.includes(':')) {
    authKind = 'password';
  } else if (userInfo !== undefined) {
    authKind = 'other';
  }
  return { host, authKind };
}

const PassphraseSchema = z
  .string()
  .min(CONNECTIONS_PASSPHRASE_MIN_LENGTH)
  .max(CONNECTIONS_PASSPHRASE_MAX_LENGTH);

export const ExportConnectionsInputSchema = z.object({
  profileIds: z.array(z.uuid()).min(1).max(CONNECTIONS_EXPORT_MAX_PROFILES),
  passphrase: PassphraseSchema,
  path: AbsolutePathSchema,
});

export const PreviewConnectionsImportInputSchema = z.object({
  path: AbsolutePathSchema,
  passphrase: PassphraseSchema,
});

/** skip leaves a colliding connection alone, rename adds a suffix, replace overwrites the existing one. */
export const ConnectionsImportModeSchema = z.enum(['skip', 'rename', 'replace']);

export const ImportConnectionsInputSchema = PreviewConnectionsImportInputSchema.extend({
  mode: ConnectionsImportModeSchema,
});

export const ConnectionsImportPreviewSchema = z.object({
  profiles: z.array(
    z.object({
      name: z.string().min(1),
      host: z.string(),
      authKind: z.enum(['none', 'password', 'x509', 'other']),
      collides: z.boolean(),
    }),
  ),
});

export const ConnectionsImportResultSchema = z.object({
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  renamed: z.number().int().nonnegative(),
  replaced: z.number().int().nonnegative(),
});

export type ConnectionsImportMode = z.infer<typeof ConnectionsImportModeSchema>;
export type ExportConnectionsInput = z.infer<typeof ExportConnectionsInputSchema>;
export type PreviewConnectionsImportInput = z.infer<typeof PreviewConnectionsImportInputSchema>;
export type ImportConnectionsInput = z.infer<typeof ImportConnectionsInputSchema>;
export type ConnectionsImportPreview = z.infer<typeof ConnectionsImportPreviewSchema>;
export type ConnectionsImportResult = z.infer<typeof ConnectionsImportResultSchema>;

/** What an import does with one connection from the file. */
export type ConnectionImportAction =
  | { readonly kind: 'create'; readonly input: ConnectionProfileInput; readonly renamed: boolean }
  | { readonly kind: 'replace'; readonly targetId: string; readonly input: ConnectionProfileInput }
  | { readonly kind: 'skip'; readonly name: string };

/**
 * Decides what each connection from a file does, in file order. A name that matches an existing
 * connection, or one created earlier in the same import, collides. Skip drops the colliding entry,
 * rename gives it the first free " (n)" suffix, and replace overwrites the first existing
 * connection with that name.
 */
export function planConnectionsImport(
  incoming: readonly ConnectionProfile[],
  existing: readonly Pick<ConnectionProfile, 'id' | 'name'>[],
  mode: ConnectionsImportMode,
): ConnectionImportAction[] {
  const taken = new Set(existing.map((connection) => connection.name));
  const idByName = new Map<string, string>();
  for (const connection of existing) {
    if (!idByName.has(connection.name)) {
      idByName.set(connection.name, connection.id);
    }
  }
  // Names whose stored connection an earlier entry already replaced. Each target is replaced once.
  const replacedNames = new Set<string>();
  return incoming.map((profile): ConnectionImportAction => {
    // The input schema drops the identity and timestamp fields, so the store assigns new ones.
    const input = ConnectionProfileInputSchema.parse(profile);
    if (!taken.has(input.name)) {
      taken.add(input.name);
      return { kind: 'create', input, renamed: false };
    }
    if (mode === 'skip') {
      return { kind: 'skip', name: input.name };
    }
    if (mode === 'replace' && !replacedNames.has(input.name)) {
      const targetId = idByName.get(input.name);
      if (targetId !== undefined) {
        replacedNames.add(input.name);
        return { kind: 'replace', targetId, input };
      }
      // A name created earlier in this import has no stored id yet, so it is renamed instead.
    }
    // A second entry with a name that was already replaced is a collision, so it is renamed.
    const name = freeName(input.name, taken);
    taken.add(name);
    return { kind: 'create', input: { ...input, name }, renamed: true };
  });
}

function freeName(base: string, taken: ReadonlySet<string>): string {
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
