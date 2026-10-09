import { describe, expect, it } from 'vitest';
import { uiPackageName } from './index';

describe('uiPackageName', () => {
  it('matches the workspace package name', () => {
    expect(uiPackageName).toBe('@mongo-gui/ui');
  });
});
