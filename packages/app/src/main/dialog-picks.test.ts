import { describe, expect, it } from 'vitest';
import { scriptedDialogs } from './dialog-picks';

const openInput = { title: 'Open', filters: [] };
const saveInput = { title: 'Save', filters: [] };

describe('scripted dialogs', () => {
  it('hands out picks in order across open and save', async () => {
    const dialogs = scriptedDialogs('["/a.json","/b.json","/c.json"]');
    expect(await dialogs.showOpenDialog(openInput)).toEqual({ path: '/a.json' });
    expect(await dialogs.showSaveDialog(saveInput)).toEqual({ path: '/b.json' });
    expect(await dialogs.showOpenDialog(openInput)).toEqual({ path: '/c.json' });
  });

  it('cancels once the queue is empty', async () => {
    const dialogs = scriptedDialogs('[]');
    expect(await dialogs.showOpenDialog(openInput)).toEqual({});
    expect(await dialogs.showSaveDialog(saveInput)).toEqual({});
  });

  it('throws on invalid JSON', () => {
    expect(() => scriptedDialogs('[/a.json')).toThrow(/not valid JSON/);
  });

  it('throws when an entry is not a string', () => {
    expect(() => scriptedDialogs('["/a.json", 3]')).toThrow(/JSON array of path strings/);
    expect(() => scriptedDialogs('{"0":"/a.json"}')).toThrow(/JSON array of path strings/);
  });
});
