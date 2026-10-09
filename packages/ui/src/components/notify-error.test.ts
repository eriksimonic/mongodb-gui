// @vitest-environment jsdom
import { AppErrorException, appError } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { errorText } from './notify-error';

function failure(message: string, detail?: string): AppErrorException {
  return new AppErrorException(appError('COMMAND_FAILED', message, detail));
}

describe('errorText', () => {
  it('shows the message alone when the error has no detail', () => {
    expect(errorText(failure('The server rejected the command'))).toBe(
      'The server rejected the command',
    );
  });

  it('shows the message followed by the server detail', () => {
    expect(
      errorText(failure('The server rejected the command', 'Document failed validation')),
    ).toBe('The server rejected the command: Document failed validation');
  });

  it('shows a detail that already starts with the message only once', () => {
    expect(errorText(failure('TTL indexes', 'TTL indexes are single-field indexes'))).toBe(
      'TTL indexes are single-field indexes',
    );
  });

  it('drops the trailing period of the message before the detail', () => {
    expect(errorText(failure('The folder does not exist.', '/exports'))).toBe(
      'The folder does not exist: /exports',
    );
  });

  it('keeps a detail that starts with the message without its period', () => {
    expect(
      errorText(failure('The folder does not exist.', 'The folder does not exist (/exports)')),
    ).toBe('The folder does not exist (/exports)');
  });
});
