import { minimalEnv } from '../shell/child';

// The environment for mongodump and mongorestore: the same allow-list as the shell runtime, without
// the mongosh-only USE_NEW_AUTOCOMPLETE flag. Connection settings travel in the config file, so no
// MONGO* variable is needed.
export function toolEnv(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env = minimalEnv(source, platform);
  delete env['USE_NEW_AUTOCOMPLETE'];
  return env;
}
