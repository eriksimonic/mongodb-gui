import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Runs before every unit test file. Only jsdom files have a window, so node-environment files skip it.
if (typeof window !== 'undefined') {
  afterEach(() => {
    cleanup();
  });
}
