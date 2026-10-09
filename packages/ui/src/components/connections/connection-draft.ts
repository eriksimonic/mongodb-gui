import type { ConnectionProfile, ConnectionProfileInput } from '@mongo-gui/core';
import {
  DEFAULT_URI,
  buildMongoUri,
  emptyUriForm,
  parseMongoUri,
  profileOptions,
  profileOptionsFromUri,
  validateUriForm,
  type UriForm,
} from './uri-form';

export type DraftMode = 'uri' | 'form';

/** Editing state for the connection dialog. The URI and the form stay in step when the mode changes. */
export interface ConnectionDraft {
  readonly name: string;
  readonly color: string;
  readonly mode: DraftMode;
  /** The URI as typed. Only used while the mode is `uri`. */
  readonly uri: string;
  /** The form fields. Only used while the mode is `form`. */
  readonly form: UriForm;
}

export type ModeSwitch =
  | { readonly ok: true; readonly draft: ConnectionDraft }
  | { readonly ok: false; readonly message: string };

export function createDraft(mode: DraftMode, source?: ConnectionProfile): ConnectionDraft {
  const uri = source?.uri ?? DEFAULT_URI;
  const parsed = parseMongoUri(uri);
  return {
    name: source?.name ?? '',
    color: source?.color ?? '',
    mode,
    uri,
    form: parsed.ok ? parsed.form : emptyUriForm(),
  };
}

/** The URI the draft currently describes, whichever mode it is in. */
export function draftUri(draft: ConnectionDraft): string {
  return draft.mode === 'uri' ? draft.uri : buildMongoUri(draft.form);
}

export function switchDraftMode(draft: ConnectionDraft, mode: DraftMode): ModeSwitch {
  if (mode === draft.mode) {
    return { ok: true, draft };
  }
  if (mode === 'uri') {
    return { ok: true, draft: { ...draft, mode, uri: buildMongoUri(draft.form) } };
  }
  const parsed = parseMongoUri(draft.uri);
  if (!parsed.ok) {
    return { ok: false, message: parsed.message };
  }
  return { ok: true, draft: { ...draft, mode, form: parsed.form } };
}

/** Returns the first problem that blocks saving or testing the draft, or undefined. */
export function validateDraft(draft: ConnectionDraft): string | undefined {
  if (draft.name.trim() === '') {
    return 'Enter a name for the connection.';
  }
  if (draft.mode === 'form') {
    return validateUriForm(draft.form);
  }
  const parsed = parseMongoUri(draft.uri);
  return parsed.ok ? validateUriForm(parsed.form) : parsed.message;
}

/** Maps the draft to the input the store sends to the backend. Optional fields are left out when unset. */
export function draftInput(draft: ConnectionDraft): ConnectionProfileInput {
  const color = draft.color.trim();
  const options =
    draft.mode === 'form' ? profileOptions(draft.form) : profileOptionsFromUri(draft.uri);
  return {
    name: draft.name.trim(),
    uri: draftUri(draft),
    ...(color === '' ? {} : { color }),
    ...options,
  };
}
