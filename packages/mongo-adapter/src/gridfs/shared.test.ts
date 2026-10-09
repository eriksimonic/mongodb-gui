import { MongoGridFSChunkError, MongoGridFSStreamError, MongoRuntimeError } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { appError, AppErrorException } from '@mongo-gui/core';
import { toGridFsFailure } from './shared';

describe('toGridFsFailure', () => {
  it('maps a driver "file not found" error to NOT_FOUND, even with the ENOENT code', () => {
    const error = new MongoRuntimeError('FileNotFound: file 1 was not found');
    Object.assign(error, { code: 'ENOENT' });
    expect(toGridFsFailure(error)).toEqual(
      appError('NOT_FOUND', 'No file with that id exists in the bucket'),
    );
    expect(toGridFsFailure(new MongoRuntimeError('File not found for id 1')).code).toBe(
      'NOT_FOUND',
    );
  });

  it('maps chunk and stream errors to COMMAND_FAILED with the driver message as detail', () => {
    expect(toGridFsFailure(new MongoGridFSChunkError('ChunkIsMissing: Got unexpected n'))).toEqual(
      appError(
        'COMMAND_FAILED',
        "The file's chunks are missing or damaged",
        'ChunkIsMissing: Got unexpected n',
      ),
    );
    expect(toGridFsFailure(new MongoGridFSStreamError('Options cannot be changed')).code).toBe(
      'COMMAND_FAILED',
    );
  });

  it('keeps the error of an AppErrorException', () => {
    const error = new AppErrorException(appError('VALIDATION', 'bad'));
    expect(toGridFsFailure(error)).toEqual(appError('VALIDATION', 'bad'));
  });

  it('leaves other runtime errors to the transfer mapping', () => {
    const failure = toGridFsFailure(new MongoRuntimeError('something else entirely'));
    expect(failure.code).toBe('CONNECTION_FAILED');
  });
});
