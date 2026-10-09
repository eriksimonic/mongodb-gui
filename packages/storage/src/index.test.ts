import { describe, expect, it } from 'vitest';
import { storagePackageName } from './index';

describe('storagePackageName', () => {
  it('matches the workspace package name', () => {
    expect(storagePackageName).toBe('@mongo-gui/storage');
  });
});
