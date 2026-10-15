import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDockerDirect, startReplicaSet, startStandalone } from '../infra/stack';
import { MONGO_URI_ENV } from '../support/mongo';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const appRoot = join(repoRoot, 'packages/app');
const builtFiles = [
  join(appRoot, 'out/renderer/index.html'),
  join(appRoot, 'out/main/shell-runtime.cjs'),
];
const segments = ['standalone', 'replset', 'docker'];

/**
 * Builds the app unless E2E_PREBUILT=1, then starts the stack for E2E_SEGMENT.
 * The returned function stops the stack after the run.
 */
// Playwright loads the global setup through its default export.
// eslint-disable-next-line no-restricted-exports
export default async function globalSetup(): Promise<() => Promise<void>> {
  const segment = process.env['E2E_SEGMENT'] ?? 'standalone';
  if (!segments.includes(segment)) {
    throw new Error(`E2E_SEGMENT must be one of ${segments.join(', ')}. Got "${segment}".`);
  }
  if (process.env['E2E_PREBUILT'] !== '1') {
    await runPnpmBuild();
  }
  for (const file of builtFiles) {
    if (!existsSync(file)) {
      throw new Error(`${file} is missing. Run pnpm build, or unset E2E_PREBUILT.`);
    }
  }
  if (segment === 'replset') {
    const replset = await startReplicaSet();
    process.env[MONGO_URI_ENV] = replset.uri;
    return replset.stop;
  }
  const standalone = await startStandalone();
  process.env[MONGO_URI_ENV] = standalone.uri;
  if (segment === 'standalone') {
    return standalone.stop;
  }
  // Docker runs the standalone stack for the saved connections, plus a container with no port.
  let docker: Awaited<ReturnType<typeof startDockerDirect>>;
  try {
    docker = await startDockerDirect();
  } catch (error) {
    await standalone.stop();
    throw error;
  }
  process.env['E2E_DOCKER_CONTAINER'] = docker.containerName;
  return async () => {
    try {
      await docker.stop();
    } finally {
      await standalone.stop();
    }
  };
}

function runPnpmBuild(): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('pnpm', ['build'], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`pnpm build failed with exit code ${code ?? 'null'}.`));
      }
    });
  });
}
