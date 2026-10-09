import { describe, expect, it } from 'vitest';
import { minimalEnv, utilityForkOptions } from './child';

describe('minimalEnv', () => {
  it('passes the POSIX names and the locale, and drops every other variable', () => {
    const env = minimalEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/u',
        TMPDIR: '/tmp',
        LANG: 'en_US.UTF-8',
        LC_CTYPE: 'UTF-8',
        MONGO_URI: 'mongodb://secret',
      },
      'linux',
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      USE_NEW_AUTOCOMPLETE: '0',
    });
  });

  it('keeps Windows names in any case and the folders Node needs on win32', () => {
    const env = minimalEnv(
      {
        Path: 'C:\\Windows\\system32',
        SystemRoot: 'C:\\Windows',
        windir: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        TMP: 'C:\\Temp',
        USERPROFILE: 'C:\\Users\\u',
        APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
        PATHEXT: '.COM;.EXE',
        ComSpec: 'C:\\Windows\\system32\\cmd.exe',
        MONGO_URI: 'mongodb://secret',
      },
      'win32',
    );
    expect(env).toEqual({
      Path: 'C:\\Windows\\system32',
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      TMP: 'C:\\Temp',
      USERPROFILE: 'C:\\Users\\u',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      PATHEXT: '.COM;.EXE',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      USE_NEW_AUTOCOMPLETE: '0',
    });
  });

  it('does not pass the Windows-only names on POSIX', () => {
    const env = minimalEnv({ SystemRoot: 'C:\\Windows', USERPROFILE: '/home/u' }, 'linux');
    expect(env).toEqual({ USE_NEW_AUTOCOMPLETE: '0' });
  });
});

describe('utilityForkOptions', () => {
  it('ignores the child output and passes only the prepared environment', () => {
    const options = utilityForkOptions({
      entryPath: '/app/out/main/shell-runtime.cjs',
      execArgv: ['--max-old-space-size=512'],
      env: { PATH: '/usr/bin', USE_NEW_AUTOCOMPLETE: '0' },
      serviceName: 'mongo-gui-shell',
    });
    expect(options).toEqual({
      env: { PATH: '/usr/bin', USE_NEW_AUTOCOMPLETE: '0' },
      execArgv: ['--max-old-space-size=512'],
      serviceName: 'mongo-gui-shell',
      stdio: 'ignore',
    });
  });
});
