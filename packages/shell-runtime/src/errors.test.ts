import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { redactText, toConnectError, toEvaluationError } from './errors';

function driverError(name: string, message: string, code?: number): Error {
  return Object.assign(new Error(message), { name, code });
}

describe('toEvaluationError', () => {
  it('reports require as unavailable in the editor, whichever way the runtime names it', () => {
    expect(toEvaluationError(new ReferenceError('require is not defined'))).toEqual({
      code: 'VALIDATION',
      message: 'require is not available in the query editor',
    });
    expect(toEvaluationError(new Error('Dynamic require of "fs" is not supported'))).toEqual({
      code: 'VALIDATION',
      message: 'require is not available in the query editor',
    });
    const bundlerStub =
      'Could not dynamically require "fs". Please configure the dynamicRequireTargets or/and ignoreDynamicRequires option of @rollup/plugin-commonjs appropriately for this require call to work.';
    expect(toEvaluationError(new Error(bundlerStub))).toEqual({
      code: 'VALIDATION',
      message: 'require is not available in the query editor',
    });
  });

  it('maps a server command failure to COMMAND_FAILED', () => {
    const error = driverError('MongoServerError', 'unknown top level operator: $bad', 2);
    expect(toEvaluationError(error)).toEqual({
      code: 'COMMAND_FAILED',
      message: 'unknown top level operator: $bad',
    });
  });

  it('maps a syntax error to VALIDATION and keeps the code frame as detail', () => {
    const error = driverError(
      'SyntaxError',
      'Unexpected token (1:9)\n\n> 1 | var x = (;\n    |         ^',
    );
    const mapped = toEvaluationError(error);
    expect(mapped.code).toBe('VALIDATION');
    expect(mapped.message).toBe('Unexpected token (1:9)');
    expect(mapped.detail).toContain('var x = (;');
  });

  it('maps a ReferenceError thrown in the mongosh vm realm to VALIDATION', () => {
    // Errors from a separate vm context are not instances of this realm's Error.
    let thrown: unknown;
    try {
      runInNewContext('missingVariable + 1');
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof Error).toBe(false);
    expect(toEvaluationError(thrown)).toEqual({
      code: 'VALIDATION',
      message: 'missingVariable is not defined',
    });
  });

  it('redacts a URI that appears in an unexpected error message', () => {
    const mapped = toEvaluationError(
      new Error('failed for mongodb://admin:secret@db.example:27017'),
    );
    expect(mapped.code).toBe('INTERNAL');
    expect(mapped.message).not.toContain('secret');
  });
});

describe('toConnectError', () => {
  it('maps authentication failure to AUTH_FAILED even when the error class differs', () => {
    const error = driverError('MongoServerError', 'Authentication failed.', 18);
    expect(toConnectError(error).code).toBe('AUTH_FAILED');
  });

  it('maps other failures to a connection error without the URI', () => {
    const mapped = toConnectError(new Error('bad host mongodb://u:pw@h:1'));
    expect(mapped.code).toBe('CONNECTION_FAILED');
    expect(mapped.detail).not.toContain('pw');
  });
});

describe('redactText', () => {
  it('masks the password in every URI in the text', () => {
    const text = redactText('a mongodb://u:pw@one and mongodb+srv://v:xy@two');
    expect(text).not.toContain('pw');
    expect(text).not.toContain('xy');
  });
});
