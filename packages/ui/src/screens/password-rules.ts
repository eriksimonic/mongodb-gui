export const MIN_PASSWORD_LENGTH = 4;

/** The length the strength meter counts as a met rule. Shorter passwords are accepted. */
export const STRONG_PASSWORD_LENGTH = 10;

const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'] as const;

export interface PasswordStrength {
  /** Number of rules met, from 0 to 4. */
  readonly score: number;
  readonly label: (typeof STRENGTH_LABELS)[number];
}

export interface NewPasswordErrors {
  readonly password: string | undefined;
  readonly confirmation: string | undefined;
}

/** Counts the rules a password meets: length, mixed case, digits and symbols. */
export function passwordStrength(password: string): PasswordStrength {
  const rules = [
    password.length >= STRONG_PASSWORD_LENGTH,
    /[a-z]/.test(password) && /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ];
  const score = rules.filter(Boolean).length;
  return { score, label: STRENGTH_LABELS[score] ?? 'Very weak' };
}

/** Checks a new master password and its confirmation. Undefined means the field is valid. */
export function validateNewPassword(password: string, confirmation: string): NewPasswordErrors {
  const passwordError =
    password.length < MIN_PASSWORD_LENGTH
      ? `Use at least ${MIN_PASSWORD_LENGTH} characters.`
      : undefined;
  let confirmationError: string | undefined;
  if (confirmation === '') {
    confirmationError = 'Type the password again.';
  } else if (confirmation !== password) {
    confirmationError = 'The passwords do not match.';
  }
  return { password: passwordError, confirmation: confirmationError };
}
