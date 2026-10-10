import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Downloads the MongoDB Database Tools pinned in mongo-tools.json and unpacks mongodump and
// mongorestore into resources/mongo-tools/<platform>/, where electron-builder picks them up.
// It imports only node: modules, so `node scripts/fetch-mongo-tools.ts` runs it as is.
//
// Usage: node scripts/fetch-mongo-tools.ts [--platform=linux-x64|win32-x64]

interface PinTarget {
  target: string;
  url: string;
  sha256: string;
}

interface Pin {
  version: string;
  targets: Record<string, PinTarget>;
}

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(appRoot, '.cache', 'mongo-tools');

function fail(message: string): never {
  console.error(`fetch-mongo-tools: ${message}`);
  process.exit(1);
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function platformArg(): string {
  const arg = process.argv.find((a) => a.startsWith('--platform='));
  return arg ? arg.slice('--platform='.length) : `${process.platform}-${process.arch}`;
}

async function download(url: string, to: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) fail(`download of ${url} failed with status ${response.status}`);
  mkdirSync(dirname(to), { recursive: true });
  const partial = `${to}.partial`;
  writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  renameSync(partial, to);
}

// Linux uses GNU tar. Windows uses the tar.exe that ships with the system, because a tar on PATH
// (Git for Windows) cannot read zip files.
function extract(archive: string, into: string, platform: string): void {
  if (platform.startsWith('linux-')) {
    if (process.platform !== 'linux')
      fail(`cannot extract ${platform} archives on ${process.platform}`);
    execFileSync('tar', ['-xzf', archive, '-C', into]);
  } else if (platform.startsWith('win32-')) {
    if (process.platform !== 'win32')
      fail(`cannot extract ${platform} archives on ${process.platform}`);
    const tar = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-xf', archive, '-C', into]);
  } else {
    fail(`no extractor for ${platform}`);
  }
}

function installedMatches(manifestPath: string, pin: Pin, entry: PinTarget): boolean {
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    return manifest['version'] === pin.version && manifest['archiveSha256'] === entry.sha256;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const platform = platformArg();
  const pin = JSON.parse(readFileSync(join(appRoot, 'mongo-tools.json'), 'utf8')) as Pin;
  const entry = pin.targets[platform];
  if (!entry) {
    console.log(`No bundled MongoDB tools for ${platform}`);
    return;
  }
  const windows = platform.startsWith('win32-');
  const [os, arch] = platform.split('-') as ['linux' | 'win32', 'x64' | 'arm64'];
  const exe = windows ? '.exe' : '';
  const outDir = join(appRoot, 'resources', 'mongo-tools', platform);
  const manifestPath = join(outDir, 'install.json');

  if (installedMatches(manifestPath, pin, entry)) {
    console.log(`MongoDB tools ${pin.version} for ${platform} are already installed`);
    return;
  }

  const archive = join(cacheDir, basename(new URL(entry.url).pathname));
  if (!existsSync(archive)) {
    console.log(`Downloading ${entry.url}`);
    await download(entry.url, archive);
  }
  const actual = sha256Of(archive);
  if (actual !== entry.sha256) {
    rmSync(archive, { force: true });
    fail(`sha256 of ${basename(archive)} is ${actual}, the pin expects ${entry.sha256}`);
  }

  const temp = mkdtempSync(join(tmpdir(), 'mongo-tools-'));
  try {
    extract(archive, temp, platform);
    const roots = readdirSync(temp);
    const root = roots.length === 1 && roots[0] ? join(temp, roots[0]) : temp;

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(join(outDir, 'bin'), { recursive: true });
    for (const name of [`mongodump${exe}`, `mongorestore${exe}`]) {
      copyFileSync(join(root, 'bin', name), join(outDir, 'bin', name));
      chmodSync(join(outDir, 'bin', name), 0o755);
    }
    for (const name of ['LICENSE.md', 'README.md', 'THIRD-PARTY-NOTICES']) {
      copyFileSync(join(root, name), join(outDir, name));
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  const dump = join(outDir, 'bin', `mongodump${exe}`);
  const versionOutput = execFileSync(dump, ['--version'], { encoding: 'utf8' });
  if (!versionOutput.includes(pin.version)) {
    fail(`mongodump --version does not report ${pin.version}: ${versionOutput.trim()}`);
  }
  const gitVersion = /git version:\s*(\S+)/i.exec(versionOutput)?.[1];
  const goVersion = /go version:\s*(\S+)/i.exec(versionOutput)?.[1];

  const manifest = {
    format: 'mongo-gui.tools',
    formatVersion: 1,
    source: 'bundled',
    version: pin.version,
    target: entry.target,
    os,
    arch,
    archiveUrl: entry.url,
    archiveSha256: entry.sha256,
    binaries: {
      mongodump: sha256Of(dump),
      mongorestore: sha256Of(join(outDir, 'bin', `mongorestore${exe}`)),
    },
    ...(gitVersion ? { gitVersion } : {}),
    ...(goVersion ? { goVersion } : {}),
    installedAt: new Date().toISOString(),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Installed MongoDB tools ${pin.version} for ${platform} into ${outDir}`);
}

await main();
