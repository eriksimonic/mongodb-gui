import { describe, expect, it } from 'vitest';
import { passwordStrength, validateNewPassword } from './password-rules';

describe('passwordStrength', () => {
  it('scores an empty password as very weak', () => {
    expect(passwordStrength('')).toEqual({ score: 0, label: 'Very weak' });
  });

  it('gives one point for length alone', () => {
    expect(passwordStrength('abcdefghij')).toEqual({ score: 1, label: 'Weak' });
  });

  it('counts mixed case, digits and symbols', () => {
    expect(passwordStrength('abcdefghiJ1')).toEqual({ score: 3, label: 'Good' });
  });

  it('scores a password that meets every rule as strong', () => {
    expect(passwordStrength('Correct-Horse-9')).toEqual({ score: 4, label: 'Strong' });
  });

  it('does not count a single letter case as mixed case', () => {
    expect(passwordStrength('ALLCAPS')).toEqual({ score: 0, label: 'Very weak' });
  });
});

describe('validateNewPassword', () => {
  it('flags a password shorter than 10 characters', () => {
    expect(validateNewPassword('short', 'short').password).toBe('Use at least 10 characters.');
  });

  it('asks for the confirmation when it is empty', () => {
    expect(validateNewPassword('a long enough password', '').confirmation).toBe(
      'Type the password again.',
    );
  });

  it('flags a confirmation that does not match', () => {
    expect(
      validateNewPassword('a long enough password', 'a long enough passwor').confirmation,
    ).toBe('The passwords do not match.');
  });

  it('returns no errors for a valid password and a matching confirmation', () => {
    expect(validateNewPassword('a long enough password', 'a long enough password')).toEqual({
      password: undefined,
      confirmation: undefined,
    });
  });
});
