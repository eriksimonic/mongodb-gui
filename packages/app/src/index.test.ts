import { describe, expect, it } from 'vitest';
import { appPackageName, workspacePackageNames } from './index';

describe('workspacePackageNames', () => {
  it('lists all six workspace packages through their resolved imports', () => {
    expect(appPackageName).toBe('@mongo-gui/app');
    expect(workspacePackageNames()).toEqual([
      '@mongo-gui/core',
      '@mongo-gui/mongo-adapter',
      '@mongo-gui/shell-runtime',
      '@mongo-gui/storage',
      '@mongo-gui/ui',
      '@mongo-gui/app',
    ]);
  });
});
