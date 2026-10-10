import {
  appError,
  AppErrorException,
  BackupSidecarSchema,
  SIDECAR_FORMAT,
  SIDECAR_VERSION,
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
 * Writes the sidecar next to the backup. The text is checked first and nothing is written when it
 * holds any of the secrets (the password in both forms, the raw URI). A short password counts only
 * when it appears as user info (":password@").
 */
export function writeSidecar(path: string, sidecar: BackupSidecar, secrets: string[]): void {
  const text = `${JSON.stringify(sidecar, null, 2)}\n`;
  if (secrets.some((secret) => leaks(text, secret))) {
    throw new AppErrorException(
      appError(
        'INTERNAL',
        'The backup description would contain a credential, so it was not written.',
      ),
    );
  }
  replaceFile(path, text);
}
