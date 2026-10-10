import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { binaryName, toolsRoots } from './paths';

const base = {
  resourcesPath: '/opt/mongo-gui/resources',
  appRoot: '/src/packages/app',
  userDataDir: '/home/u/.config/mongo-gui',
  platform: 'linux' as const,
  arch: 'x64',
};

describe('toolsRoots', () => {
  it('uses the resources folder in a packaged app', () => {
    expect(toolsRoots({ ...base, isPackaged: true })).toEqual({
      bundled: join('/opt/mongo-gui/resources', 'mongo-tools'),
      downloaded: join('/home/u/.config/mongo-gui', 'mongo-tools'),
      tmp: join('/home/u/.config/mongo-gui', 'tmp'),
    });
  });

  it('uses the per-platform folder under the app in development', () => {
    expect(toolsRoots({ ...base, isPackaged: false, platform: 'win32', arch: 'x64' }).bundled).toBe(
      join('/src/packages/app', 'resources', 'mongo-tools', 'win32-x64'),
    );
  });
});

describe('binaryName', () => {
  it('adds .exe on Windows only', () => {
    expect(binaryName('mongodump', 'win32')).toBe('mongodump.exe');
    expect(binaryName('mongorestore', 'linux')).toBe('mongorestore');
    expect(binaryName('mongodump', 'darwin')).toBe('mongodump');
  });
});
