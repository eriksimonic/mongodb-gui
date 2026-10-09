import { describe, expect, it } from 'vitest';
import { appError } from '@mongo-gui/core';
import { errorText } from './notify-error';

describe('errorText', () => {
  it('shows the message alone when there is no detail', () => {
    expect(errorText(appError('VALIDATION', 'The folder does not exist.'))).toBe(
      'The folder does not exist.',
    );
  });

  it('joins the detail with a colon and drops the period of the message', () => {
    expect(errorText(appError('VALIDATION', 'The folder does not exist.', '/exports'))).toBe(
      'The folder does not exist: /exports',
    );
  });
});
