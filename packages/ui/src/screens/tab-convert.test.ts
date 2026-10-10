import { describe, expect, it, vi } from 'vitest';
import { EMPTY_EDITORS, openTab } from '../state/editors';
import { convertEntries } from './tab-convert';

const TAB_ID = '6b0f6f2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

function sqlTab(text: string) {
  const state = openTab(EMPTY_EDITORS, {
    id: TAB_ID,
    connectionId: CONNECTION_ID,
    database: 'shop',
    language: 'sql',
    text,
  });
  const tab = state.tabs[TAB_ID];
  if (tab === undefined) {
    throw new Error('no tab');
  }
  return tab;
}

describe('convertEntries', () => {
  it('offers Open in Mongo after a divider when the SQL translates', () => {
    const onSelect = vi.fn();
    const entries = convertEntries(sqlTab('SELECT * FROM orders'), onSelect);
    expect(entries).toEqual([
      { kind: 'divider' },
      { kind: 'item', label: 'Open in Mongo', disabled: false, reason: undefined, onSelect },
    ]);
  });

  it('opens the tab when the entry is picked', () => {
    const onSelect = vi.fn();
    const [, entry] = convertEntries(sqlTab('SELECT * FROM orders'), onSelect);
    if (entry?.kind !== 'item') {
      throw new Error('no item');
    }
    entry.onSelect();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('is off with the error as the reason when the SQL does not translate', () => {
    const [, entry] = convertEntries(sqlTab('SELECT * FROM orders WHERE'), vi.fn());
    expect(entry).toMatchObject({
      disabled: true,
      reason: 'expected an expression but the statement ended',
    });
  });

  it('reports the first failing statement of several', () => {
    const [, entry] = convertEntries(
      sqlTab('SELECT * FROM orders; SELEC * FROM items; DELETE FROM'),
      vi.fn(),
    );
    expect(entry).toMatchObject({
      disabled: true,
      reason: 'Only SELECT, UPDATE, DELETE, INSERT and TRUNCATE statements are supported',
    });
  });

  it('is off for an empty tab', () => {
    const [, entry] = convertEntries(sqlTab('  \n'), vi.fn());
    expect(entry).toMatchObject({ disabled: true, reason: 'The tab is empty' });
  });

  it('is off for text that holds only comments', () => {
    const [, entry] = convertEntries(sqlTab('-- nothing yet'), vi.fn());
    expect(entry).toMatchObject({ disabled: true, reason: 'The tab has no statement' });
  });
});
