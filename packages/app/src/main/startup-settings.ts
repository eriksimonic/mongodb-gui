import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StartupSettingsSchema, type StartupSettings } from '@mongo-gui/core';

const FILE_NAME = 'startup.json';
const DEFAULTS: StartupSettings = { disableGpu: false };

/** Reads the start-up options. A missing or damaged file gives the defaults. */
export function readStartupSettings(userDataDir: string): StartupSettings {
  try {
    const parsed = StartupSettingsSchema.safeParse(
      JSON.parse(readFileSync(join(userDataDir, FILE_NAME), 'utf8')),
    );
    return parsed.success ? parsed.data : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

/** Writes the options through a temporary file, so a crash cannot leave half a file. */
export function writeStartupSettings(userDataDir: string, settings: StartupSettings): void {
  const path = join(userDataDir, FILE_NAME);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings)}\n`);
  renameSync(temporary, path);
}
