/**
 * The YAML config file the Database Tools read with `--config`. It holds only the URI, so the
 * argv carries no host, user or password. The value is a double-quoted YAML scalar, in which
 * only `\` and `"` need escaping. Control characters are refused rather than escaped, because a
 * URI never holds one legitimately.
 */
export function toolsConfigYaml(uri: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(uri)) {
    throw new Error('The connection URI contains a control character');
  }
  return `uri: "${uri.replace(/[\\"]/g, (character) => `\\${character}`)}"\n`;
}
