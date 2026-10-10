import { describe, expect, it } from 'vitest';
import { appError, type ReplicaSetStatus } from '@mongo-gui/core';
import {
  duplicateTagKey,
  electionEvents,
  formatDuration,
  formatLag,
  isNoReplicationError,
  isUninitiatedError,
  memberMeaning,
  oplogWindowLabel,
  rowsToTags,
  tagsToRows,
} from './replication-model';

function statusWith(overrides: Partial<ReplicaSetStatus> = {}): ReplicaSetStatus {
  return {
    setName: 'rs0',
    myState: 1,
    term: 3,
    members: [],
    ...overrides,
  };
}

describe('memberMeaning', () => {
  it('reads each state as its meaning', () => {
    expect(memberMeaning({ state: 'PRIMARY', health: 1 })).toBe('primary');
    expect(memberMeaning({ state: 'SECONDARY', health: 1 })).toBe('secondary');
    expect(memberMeaning({ state: 'ARBITER', health: 1 })).toBe('arbiter');
    expect(memberMeaning({ state: 'RECOVERING', health: 1 })).toBe('recovering');
    expect(memberMeaning({ state: 'STARTUP2', health: 1 })).toBe('recovering');
  });

  it('reads an unhealthy member as down whatever its last state', () => {
    expect(memberMeaning({ state: 'SECONDARY', health: 0 })).toBe('down');
    expect(memberMeaning({ state: 'DOWN', health: 1 })).toBe('down');
  });
});

describe('formatLag', () => {
  it('keeps a decimal under a minute and shows a dash without a lag', () => {
    expect(formatLag(2.5)).toBe('2.5 s');
    expect(formatLag(0)).toBe('0.0 s');
    expect(formatLag(undefined)).toBe('–');
  });

  it('shows longer lags in minutes and hours', () => {
    expect(formatLag(184)).toBe('3 min 4 s');
    expect(formatLag(3720)).toBe('1 h 2 min');
    expect(formatDuration(59)).toBe('59 s');
  });
});

describe('oplogWindowLabel', () => {
  it('shows the window and the configured size', () => {
    const status = statusWith({
      oplog: {
        firstTs: '2026-10-09T09:00:00.000Z',
        lastTs: '2026-10-09T10:00:00.000Z',
        windowSeconds: 3600,
        sizeMb: 512,
      },
    });
    expect(oplogWindowLabel(status)).toBe('1 h 0 min of 512 MB');
    expect(oplogWindowLabel(statusWith())).toBe('Unknown');
  });
});

describe('electionEvents', () => {
  it('lists the elected primaries and the last election, newest first', () => {
    const events = electionEvents(
      statusWith({
        term: 4,
        members: [
          {
            id: 0,
            name: 'a:1',
            state: 'PRIMARY',
            stateCode: 1,
            health: 1,
            self: true,
            priority: 1,
            votes: 1,
            hidden: false,
            arbiterOnly: false,
            buildIndexes: true,
            secondaryDelaySecs: 0,
            tags: {},
            electionDate: '2026-10-09T09:00:00.000Z',
          },
        ],
        electionCandidateMetrics: {
          lastElectionReason: 'stepUpRequest',
          termAtLastElection: 4,
          lastElectionDate: '2026-10-09T10:00:00.000Z',
        },
      }),
    );
    expect(events).toEqual([
      { at: '2026-10-09T10:00:00.000Z', summary: 'Last election after stepUpRequest (term 4)' },
      { at: '2026-10-09T09:00:00.000Z', summary: 'a:1 became primary (term 4)' },
    ]);
  });

  it('returns nothing when the status carries no election data', () => {
    expect(electionEvents(statusWith())).toEqual([]);
  });
});

describe('uninitiated and standalone errors', () => {
  it('recognises the server wording the adapter passes through as detail', () => {
    expect(
      isUninitiatedError(
        appError(
          'COMMAND_FAILED',
          'The server rejected the command',
          'no replset config has been received',
        ),
      ),
    ).toBe(true);
    expect(
      isNoReplicationError(
        appError('COMMAND_FAILED', 'The server rejected the command', 'not running with --replSet'),
      ),
    ).toBe(true);
    expect(isUninitiatedError(appError('CONNECTION_FAILED', 'Could not connect'))).toBe(false);
    expect(isUninitiatedError(undefined)).toBe(false);
  });
});

describe('tag rows', () => {
  it('round trips tags and drops rows with an empty key', () => {
    const rows = tagsToRows({ dc: 'east' });
    expect(rowsToTags([...rows, { key: '  ', value: 'x' }])).toEqual({ dc: 'east' });
  });

  it('names a repeated key', () => {
    expect(
      duplicateTagKey([
        { key: 'dc', value: 'east' },
        { key: 'dc', value: 'west' },
      ]),
    ).toBe('dc');
    expect(duplicateTagKey([{ key: 'dc', value: 'east' }])).toBeUndefined();
  });

  it('detects the server error names before it reads the detail', () => {
    expect(isUninitiatedError(appError('COMMAND_FAILED', 'The server rejected the command'))).toBe(
      false,
    );
    expect(
      isUninitiatedError({
        ...appError('COMMAND_FAILED', 'The server rejected the command'),
        codeName: 'NotYetInitialized',
      }),
    ).toBe(true);
    expect(
      isNoReplicationError({
        ...appError('COMMAND_FAILED', 'The server rejected the command'),
        codeName: 'NoReplicationEnabled',
      }),
    ).toBe(true);
  });
});
