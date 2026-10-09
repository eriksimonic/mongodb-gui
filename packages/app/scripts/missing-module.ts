// Builds the stand-in for an optional driver module that is not installed. The driver checks for
// kModuleError, the way it does for its own missing modules. Reading any other property throws the
// driver's install message, so a feature that needs the module fails with that message and not a
// TypeError. Keys the loader reads while it wraps a module pass through as undefined.
const PASSTHROUGH: ReadonlySet<string | symbol> = new Set([
  '__esModule',
  'default',
  'then',
  'version',
]);

export function missingModule(message: string): Record<string, unknown> {
  const error = new Error(message);
  error.name = 'MongoMissingDependencyError';
  Object.assign(error, { code: 'MODULE_NOT_FOUND' });
  return new Proxy(
    {},
    {
      get(_target, key: string | symbol) {
        if (key === 'kModuleError') {
          return error;
        }
        if (typeof key === 'symbol' || PASSTHROUGH.has(key)) {
          return undefined;
        }
        throw error;
      },
      has(_target, key: string | symbol) {
        return key === 'kModuleError';
      },
      set(): never {
        throw error;
      },
    },
  ) as Record<string, unknown>;
}
