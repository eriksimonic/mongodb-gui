import { CONNECTIONS_PASSPHRASE_MIN_LENGTH, type ConnectionsImportMode } from '@mongo-gui/core';

export const CONNECTIONS_FILE_FILTER = { name: 'Mongo GUI connections', extensions: ['mgconn'] };
export const CONNECTIONS_FILE_NAME = 'mongo-gui-connections.mgconn';
export const PASSPHRASE_HINT = `At least ${CONNECTIONS_PASSPHRASE_MIN_LENGTH} characters. The file cannot be opened without it.`;

export const IMPORT_MODE_OPTIONS: readonly { value: ConnectionsImportMode; label: string }[] = [
  { value: 'rename', label: 'Import as copies (adds a number to the name)' },
  { value: 'skip', label: 'Skip connections whose name exists' },
  { value: 'replace', label: 'Replace the existing connection' },
];

export interface NewPassphraseErrors {
  readonly passphrase: string | undefined;
  readonly confirmation: string | undefined;
}

/** Checks a passphrase that the user types for a new export. The confirmation must match it. */
export function validateNewPassphrase(
  passphrase: string,
  confirmation: string,
): NewPassphraseErrors {
  return {
    passphrase:
      passphrase.length < CONNECTIONS_PASSPHRASE_MIN_LENGTH
        ? `The passphrase must be at least ${CONNECTIONS_PASSPHRASE_MIN_LENGTH} characters.`
        : undefined,
    confirmation: confirmation === passphrase ? undefined : 'The passphrases do not match.',
  };
}

/** Checks the passphrase of an existing file. The length rule is the same as for a new one. */
export function validateExistingPassphrase(passphrase: string): string | undefined {
  return passphrase.length < CONNECTIONS_PASSPHRASE_MIN_LENGTH
    ? `The passphrase must be at least ${CONNECTIONS_PASSPHRASE_MIN_LENGTH} characters.`
    : undefined;
}

/** The export needs at least one connection. */
export function selectionProblem(selected: readonly string[]): string | undefined {
  return selected.length === 0 ? 'Select at least one connection.' : undefined;
}
