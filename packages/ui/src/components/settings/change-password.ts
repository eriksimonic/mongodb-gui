import { validateNewPassword, type NewPasswordErrors } from '../../screens/password-rules';

export interface ChangePasswordDraft {
  readonly current: string;
  readonly next: string;
  readonly confirmation: string;
}

export interface ChangePasswordErrors extends NewPasswordErrors {
  readonly current: string | undefined;
}

/**
 * Checks the change-password form. The new password follows the first-run rules. The new password
 * must also differ from the current one, so a change never leaves the master password as it was.
 */
export function validateChangePassword(draft: ChangePasswordDraft): ChangePasswordErrors {
  const fresh = validateNewPassword(draft.next, draft.confirmation);
  let current: string | undefined;
  if (draft.current === '') {
    current = 'Enter the current master password.';
  }
  let next = fresh.password;
  if (next === undefined && draft.next === draft.current && draft.next !== '') {
    next = 'Choose a password that differs from the current one.';
  }
  return { current, password: next, confirmation: fresh.confirmation };
}

/** True when the form has no errors and can be submitted. */
export function isChangePasswordValid(errors: ChangePasswordErrors): boolean {
  return (
    errors.current === undefined &&
    errors.password === undefined &&
    errors.confirmation === undefined
  );
}
