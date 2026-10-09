import { describe, expect, it } from 'vitest';
import { mongoAdapterPackageName } from './index';

describe('mongoAdapterPackageName', () => {
  it('matches the workspace package name', () => {
    expect(mongoAdapterPackageName).toBe('@mongo-gui/mongo-adapter');
  });
});
