/** The problem with a password and its confirmation, or undefined when they are usable. */
export function passwordError(password: string, confirm: string): string | undefined {
  if (password === '') {
    return 'Enter a password';
  }
  if (password !== confirm) {
    return 'The passwords do not match';
  }
  return undefined;
}
