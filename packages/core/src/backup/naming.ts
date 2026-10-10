import type { BackupScope } from './options';
import { BackupNameSchema } from './options';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function stamp(now: Date): string {
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function sanitise(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/-{2,}/g, '-')
      .replace(/^[-. ]+|[. ]+$/g, '')
  );
}

// <connection>-<db or "all">[-<collection>]-<yyyyMMdd-HHmmss>, local time.
export function defaultBackupName(connectionName: string, scope: BackupScope, now: Date): string {
  const parts = [connectionName];
  if (scope.kind === 'server') parts.push('all');
  else if (scope.kind === 'database') parts.push(scope.database);
  else if (scope.kind === 'databases') parts.push(`${scope.databases.length}-databases`);
  else parts.push(scope.database, scope.collection);
  const suffix = stamp(now);
  const head = sanitise(parts.join('-')).slice(0, 200 - suffix.length - 1);
  const name = sanitise(`${head}-${suffix}`);
  return BackupNameSchema.safeParse(name).success ? name : `backup-${suffix}`;
}

// The archive file name, or the folder name for the directory format.
export function backupFileName(
  name: string,
  options: { output: 'archive' | 'directory'; gzip: boolean },
): string {
  if (options.output === 'directory') return name;
  return options.gzip ? `${name}.archive.gz` : `${name}.archive`;
}

// Archive: next to the file. Directory: inside the dump folder.
export function sidecarPathFor(outputPath: string, kind: 'archive' | 'directory'): string {
  if (kind === 'archive') return `${outputPath}.json`;
  const sep = outputPath.includes('\\') && !outputPath.includes('/') ? '\\' : '/';
  const base = outputPath.endsWith(sep) ? outputPath.slice(0, -1) : outputPath;
  return `${base}${sep}mongo-gui-backup.json`;
}

// gzip starts 1f 8b. A plain mongodump archive starts 6d e2 99 81.
export function detectArchiveKind(firstBytes: Uint8Array): 'gzip' | 'archive' | 'unknown' {
  const [a, b, c, d] = firstBytes;
  if (a === 0x1f && b === 0x8b) return 'gzip';
  if (a === 0x6d && b === 0xe2 && c === 0x99 && d === 0x81) return 'archive';
  return 'unknown';
}
