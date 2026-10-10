import { describe, expect, it } from 'vitest';
import { toolsConfigYaml } from './config-file';

describe('toolsConfigYaml', () => {
  it('writes the URI as one quoted value', () => {
    expect(toolsConfigYaml('mongodb://u:p%40ss@127.0.0.1:49152/?authSource=admin')).toBe(
      'uri: "mongodb://u:p%40ss@127.0.0.1:49152/?authSource=admin"\n',
    );
  });

  it('escapes backslashes and double quotes', () => {
    expect(toolsConfigYaml('mongodb://u:a"b\\c@h/')).toBe('uri: "mongodb://u:a\\"b\\\\c@h/"\n');
  });

  it.each(['\n', '\r', '\t', '\u0000', '\u007f', '\u0085', ' '])(
    'refuses the control character %j',
    (character) => {
      expect(() => toolsConfigYaml(`mongodb://h/${character}`)).toThrow('control character');
    },
  );
});
