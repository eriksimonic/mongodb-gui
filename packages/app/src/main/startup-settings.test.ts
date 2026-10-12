import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readStartupSettings, writeStartupSettings } from './startup-settings';

describe('startup settings', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mongo-gui-startup-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to GPU on when there is no file', () => {
    expect(readStartupSettings(dir)).toEqual({ disableGpu: false });
  });

  it('reads back what it wrote', () => {
    writeStartupSettings(dir, { disableGpu: true });
    expect(readStartupSettings(dir)).toEqual({ disableGpu: true });
  });

  it('falls back to the defaults for a damaged or wrong file', () => {
    writeFileSync(join(dir, 'startup.json'), '{oops');
    expect(readStartupSettings(dir)).toEqual({ disableGpu: false });
    writeFileSync(join(dir, 'startup.json'), '{"disableGpu":"yes"}');
    expect(readStartupSettings(dir)).toEqual({ disableGpu: false });
  });
});
