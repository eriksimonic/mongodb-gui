import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { MONGO_URI_ENV, startSeededMongo } from './support/mongo';

const repoRoot = resolve(import.meta.dirname, '..');

/**
 * Builds the app so every run tests fresh output, then starts the seeded MongoDB container.
 * The returned function stops the container after the run.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  await runPnpmBuild();
  const mongo = await startSeededMongo();
  process.env[MONGO_URI_ENV] = mongo.uri;
  return async () => {
    await mongo.stop();
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
