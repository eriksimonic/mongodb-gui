import {
  appError,
  AppErrorException,
  BackupSidecarSchema,
  MONGO_SCHEME,
  SIDECAR_FORMAT,
  SIDECAR_VERSION,
  userInfoEnd,
  type BackupSidecar,
} from '@mongo-gui/core';
import { replaceFile } from '../rpc/export-file';

/** What the dump job knows when it finishes. Format, app name, duration and totals are derived. */
export type SidecarFacts = Omit<
  BackupSidecar,
  'format' | 'formatVersion' | 'app' | 'durationMs' | 'totals'
> & { appVersion: string };

export function buildSidecar(facts: SidecarFacts): BackupSidecar {
  const { appVersion, ...rest } = facts;
  const collections = rest.databases.reduce((sum, db) => sum + db.collections.length, 0);
  const documents = rest.databases.reduce(
    (sum, db) => sum + db.collections.reduce((inner, c) => inner + c.documents, 0),
    0,
  );
  const durationMs = Math.max(0, Date.parse(rest.finishedAt) - Date.parse(rest.startedAt));
  return BackupSidecarSchema.parse({
    format: SIDECAR_FORMAT,
    formatVersion: SIDECAR_VERSION,
    app: { name: 'Mongo GUI', version: appVersion },
    ...rest,
    durationMs,
    totals: { databases: rest.databases.length, collections, documents },
  });
}

/**
 * Secrets shorter than this are only matched in user info form. The same floor as redactPassword:
 * a short password such as "admin" or "mongo" turns up in ordinary sidecar text by chance.
 */
const MIN_SECRET_LENGTH_TO_MATCH = 8;

function leaks(text: string, secret: string): boolean {
  if (secret === '') return false;
  if (secret.length >= MIN_SECRET_LENGTH_TO_MATCH) return text.includes(secret);
  return text.includes(`:${secret}@`);
}

/**
 * A connection URI with no user info holds no credential, and the sidecar names the same host and
 * port, so the raw URI would otherwise match as a prefix of the sidecar's own URI.
 */
function isUriWithoutUserInfo(secret: string): boolean {
  const scheme = MONGO_SCHEME.exec(secret)?.[0];
  return scheme !== undefined && userInfoEnd(secret.slice(scheme.length)) === -1;
}

/**
 * Writes the sidecar next to the backup. The text is checked first and nothing is written when it
 * holds any of the secrets (the password in both forms, the raw URI). A short password counts only
 * when it appears as user info (":password@").
 */
export function writeSidecar(path: string, sidecar: BackupSidecar, secrets: string[]): void {
  const text = `${JSON.stringify(sidecar, null, 2)}\n`;
  const checked = secrets.filter((secret) => !isUriWithoutUserInfo(secret));
  if (checked.some((secret) => leaks(text, secret))) {
    throw new AppErrorException(
      appError(
        'INTERNAL',
        'The backup description would contain a credential, so it was not written.',
      ),
    );
  }
  replaceFile(path, text);
}
