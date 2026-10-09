import type { ConnectionProfile } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { createDraft, draftInput, switchDraftMode, validateDraft } from './connection-draft';

const profile: ConnectionProfile = {
  id: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10',
  name: 'Local dev',
  color: '#3b82f6',
  uri: 'mongodb://app:secret@localhost:27017/?authSource=admin',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
};

describe('createDraft', () => {
  it('starts from the profile when editing', () => {
    const draft = createDraft('uri', profile);
    expect(draft.name).toBe('Local dev');
    expect(draft.color).toBe('#3b82f6');
    expect(draft.uri).toBe(profile.uri);
    expect(draft.form.username).toBe('app');
  });

  it('starts from the default URI when creating', () => {
    const draft = createDraft('form');
    expect(draft.mode).toBe('form');
    expect(draft.uri).toBe('mongodb://localhost:27017/');
    expect(draft.form.hosts).toEqual(['localhost:27017']);
  });
});

describe('switchDraftMode', () => {
  it('fills the form from the URI when switching to form mode', () => {
    const result = switchDraftMode(createDraft('uri', profile), 'form');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.mode).toBe('form');
      expect(result.draft.form.password).toBe('secret');
    }
  });

  it('writes the form back into the URI when switching to URI mode', () => {
    const toForm = switchDraftMode(createDraft('uri', profile), 'form');
    if (!toForm.ok) {
      throw new Error('expected the switch to succeed');
    }
    const edited = {
      ...toForm.draft,
      form: { ...toForm.draft.form, hosts: ['db.example.net:27017'] },
    };
    const back = switchDraftMode(edited, 'uri');
    expect(back.ok && back.draft.uri).toBe(
      'mongodb://app:secret@db.example.net:27017/?authSource=admin',
    );
  });

  it('keeps the mode when the URI cannot be read as a form', () => {
    const draft = { ...createDraft('uri'), uri: 'not a uri' };
    const result = switchDraftMode(draft, 'form');
    expect(result).toEqual({
      ok: false,
      message: 'The URI must start with mongodb:// or mongodb+srv://.',
    });
  });

  it('round trips the URI through both modes unchanged', () => {
    const start = createDraft('uri', profile);
    const form = switchDraftMode(start, 'form');
    if (!form.ok) {
      throw new Error('expected the switch to succeed');
    }
    const back = switchDraftMode(form.draft, 'uri');
    expect(back.ok && back.draft.uri).toBe(profile.uri);
  });
});

describe('validateDraft', () => {
  it('asks for a name', () => {
    expect(validateDraft({ ...createDraft('uri'), name: '  ' })).toBe(
      'Enter a name for the connection.',
    );
  });

  it('reports a URI that is not a mongo URI', () => {
    const draft = { ...createDraft('uri'), name: 'Dev', uri: 'http://localhost' };
    expect(validateDraft(draft)).toBe('The URI must start with mongodb:// or mongodb+srv://.');
  });

  it('checks the form fields in form mode', () => {
    const form = createDraft('form');
    const draft = { ...form, name: 'Dev', form: { ...form.form, hosts: [] } };
    expect(validateDraft(draft)).toBe('Add at least one host.');
  });

  it('accepts a complete draft', () => {
    expect(validateDraft({ ...createDraft('uri', profile), name: 'Dev' })).toBeUndefined();
  });
});

describe('draftInput', () => {
  it('trims the name and leaves out an empty colour', () => {
    const input = draftInput({ ...createDraft('uri'), name: '  Dev  ', color: '' });
    expect(input).toEqual({ name: 'Dev', uri: 'mongodb://localhost:27017/' });
  });

  it('takes TLS options from the URI in URI mode', () => {
    const draft = { ...createDraft('uri'), name: 'Tls', uri: 'mongodb://localhost/?tls=true' };
    expect(draftInput(draft).tls).toEqual({ enabled: true });
  });

  it('takes TLS options from the form in form mode', () => {
    const form = createDraft('form');
    const draft = {
      ...form,
      name: 'Tls',
      form: { ...form.form, tls: { ...form.form.tls, enabled: true, caFile: '/etc/ca.pem' } },
    };
    expect(draftInput(draft).tls).toEqual({ enabled: true, caFile: '/etc/ca.pem' });
  });
});
