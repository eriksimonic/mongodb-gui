import { describe, expect, it } from 'vitest';
import { corePackageName } from './index';

describe('corePackageName', () => {
  it('matches the workspace package name', () => {
    expect(corePackageName).toBe('@mongo-gui/core');
  });
});
