import { describe, expect, it } from 'vitest';
import {
  selectionProblem,
  validateExistingPassphrase,
  validateNewPassphrase,
} from './connections-file-model';

describe('connections file form rules', () => {
  it('requires ten characters and a matching confirmation for a new passphrase', () => {
    expect(validateNewPassphrase('123456789', '123456789')).toEqual({
      passphrase: 'The passphrase must be at least 10 characters.',
      confirmation: undefined,
    });
    expect(validateNewPassphrase('1234567890', '1234567891')).toEqual({
      passphrase: undefined,
      confirmation: 'The passphrases do not match.',
    });
    expect(validateNewPassphrase('1234567890', '1234567890')).toEqual({
      passphrase: undefined,
      confirmation: undefined,
    });
  });

  it('applies the same length rule to an existing file', () => {
    expect(validateExistingPassphrase('short')).toBe(
      'The passphrase must be at least 10 characters.',
    );
    expect(validateExistingPassphrase('long enough')).toBeUndefined();
  });

  it('refuses an export with no connection selected', () => {
    expect(selectionProblem([])).toBe('Select at least one connection.');
    expect(selectionProblem(['a'])).toBeUndefined();
  });
});
