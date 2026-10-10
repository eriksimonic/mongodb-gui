import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readTarGz, type ArchiveEntry } from './tar';
import { readZip } from './zip';

const DOCS = new Set(['LICENSE.md', 'README.md', 'THIRD-PARTY-NOTICES']);
const BINARIES = new Set(['bin/mongodump', 'bin/mongorestore', 'bin/mongodump.exe', 'bin/mongorestore.exe']);

function checkName(name: string, kind: 'tgz' | 'zip'): string[] {
  if (kind === 'tgz' && name.includes('\\')) throw new Error(`Unsafe path in archive: ${name}`);
  const unified = name.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) throw new Error(`Unsafe path in archive: ${name}`);
  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) throw new Error(`Unsafe path in archive: ${name}`);
  return segments;
}

/**
 * Unpacks the wanted files of a MongoDB Database Tools archive into targetDir, dropping the
 * top folder. Returns the relative paths written.
 */
export async function extractToolsArchive(
  buffer: Buffer,
  kind: 'tgz' | 'zip',
  targetDir: string,
  platform: NodeJS.Platform,
): Promise<string[]> {
  const entries: ArchiveEntry[] = kind === 'tgz' ? readTarGz(buffer) : readZip(buffer);
  const written: string[] = [];
  for (const entry of entries) {
    const segments = checkName(entry.name, kind);
    const relative = segments.slice(1).join('/');
    const isBinary = BINARIES.has(relative);
    if (!isBinary && !DOCS.has(relative)) continue;
    const destination = join(targetDir, ...relative.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.data);
    if (isBinary && platform !== 'win32') await chmod(destination, 0o755);
    written.push(relative);
  }
  return written;
}
