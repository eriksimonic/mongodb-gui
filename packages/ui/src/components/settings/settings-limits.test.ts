import { describe, expect, it } from 'vitest';
import { EDITOR_FONT_SIZE_RANGE, IDLE_LOCK_RANGE, clampToRange } from './settings-limits';
import { isChangePasswordValid, validateChangePassword } from './change-password';

describe('clampToRange', () => {
  it('keeps the idle lock between 1 and 1440 minutes', () => {
    expect(clampToRange(0, IDLE_LOCK_RANGE)).toBe(1);
    expect(clampToRange(5000, IDLE_LOCK_RANGE)).toBe(1440);
    expect(clampToRange(30, IDLE_LOCK_RANGE)).toBe(30);
  });

  it('rounds a typed fraction to a whole number', () => {
    expect(clampToRange(12.6, EDITOR_FONT_SIZE_RANGE)).toBe(13);
  });

  it('lets the low bound win over an inverted range', () => {
    expect(clampToRange(5, { min: 10, max: 1 })).toBe(10);
  });
});

describe('validateChangePassword', () => {
  const valid = {
    current: 'correct horse battery',
    next: 'staple battery horse',
    confirmation: 'staple battery horse',
  };

  it('accepts a new password that meets the rules and matches its confirmation', () => {
    const errors = validateChangePassword(valid);
    expect(isChangePasswordValid(errors)).toBe(true);
  });

  it('requires the current password', () => {
    const errors = validateChangePassword({ ...valid, current: '' });
    expect(errors.current).toBe('Enter the current master password.');
    expect(isChangePasswordValid(errors)).toBe(false);
  });

  it('applies the first-run length rule to the new password', () => {
    const errors = validateChangePassword({ ...valid, next: 'short', confirmation: 'short' });
    expect(errors.password).toBe('Use at least 10 characters.');
  });

  it('asks for the confirmation and reports a mismatch', () => {
    expect(validateChangePassword({ ...valid, confirmation: '' }).confirmation).toBe(
      'Type the password again.',
    );
    expect(
      validateChangePassword({ ...valid, confirmation: 'staple battery horsex' }).confirmation,
    ).toBe('The passwords do not match.');
  });

  it('rejects a new password that equals the current one', () => {
    const same = 'correct horse battery';
    const errors = validateChangePassword({ current: same, next: same, confirmation: same });
    expect(errors.password).toBe('Choose a password that differs from the current one.');
  });
});
