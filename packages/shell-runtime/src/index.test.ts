import { describe, expect, it } from 'vitest';
import { shellRuntimeDependencies, shellRuntimePackageName } from './index';

describe('shell-runtime', () => {
  it('names itself and lists the workspace packages it resolves through', () => {
    expect(shellRuntimePackageName).toBe('@mongo-gui/shell-runtime');
    expect(shellRuntimeDependencies).toEqual(['@mongo-gui/core', '@mongo-gui/mongo-adapter']);
  });
});
