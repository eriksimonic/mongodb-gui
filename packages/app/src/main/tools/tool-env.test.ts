import { describe, expect, it } from 'vitest';
import { toolEnv } from './tool-env';

describe('toolEnv', () => {
  it('keeps the allow-listed names and drops the rest and the mongosh flag', () => {
    const env = toolEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/u',
        LC_ALL: 'C',
        MONGODB_URI: 'mongodb://secret',
        USE_NEW_AUTOCOMPLETE: '1',
      },
      'linux',
    );
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', LC_ALL: 'C' });
  });

  it('keeps the Windows names Go needs to start', () => {
    const env = toolEnv({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', APPDATA: 'x' }, 'win32');
    expect(env).toEqual({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', APPDATA: 'x' });
  });
});
