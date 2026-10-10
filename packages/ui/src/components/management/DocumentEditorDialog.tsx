import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { errorText } from '../notify-error';
import { useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { JsonEditor } from '../../editor/JsonEditor';
import { parseJsonObject } from '../../management/input-rules';

export type DocumentEditorMode = 'edit' | 'duplicate' | 'insert';

export interface DocumentEditorDialogProps {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly mode: DocumentEditorMode;
  /** The document as EJSON text, or `{}` for a new document. */
  readonly initialText: string;
  /** The `_id` as EJSON. Required when editing, because replace needs it. */
  readonly idEjson?: string | undefined;
  readonly onClose: () => void;
  /** Called with the saved EJSON after an edit is written. Other modes do not call it. */
  readonly onSaved?: ((documentEjson: string) => void) | undefined;
}

const TITLES: Readonly<Record<DocumentEditorMode, string>> = {
  edit: 'Edit document',
  duplicate: 'Duplicate document',
  insert: 'Insert document',
};

const SAVE_LABELS: Readonly<Record<DocumentEditorMode, string>> = {
  edit: 'Save',
  duplicate: 'Insert copy',
  insert: 'Insert',
};

/**
 * Edits one document as canonical EJSON. Edit replaces the document with the same `_id`. Duplicate
 * and insert add a new document, and the server makes an `_id` when the text has none.
 */
export function DocumentEditorDialog({
  connectionId,
  database,
  collection,
  mode,
  initialText,
  idEjson,
  onClose,
  onSaved,
}: DocumentEditorDialogProps) {
  const { rpc } = useUiApi();
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function save() {
    const parsed = parseJsonObject(text);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      if (mode === 'edit') {
        if (idEjson === undefined) {
          throw new Error('The document has no _id');
        }
        await rpc.management.replaceDocument({
          connectionId,
          database,
          collection,
          idEjson,
          documentEjson: text,
        });
        onSaved?.(text);
      } else {
        await rpc.management.insertDocument({
          connectionId,
          database,
          collection,
          documentEjson: text,
        });
      }
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title={`${TITLES[mode]} in ${collection}`} centered size="lg">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            {mode === 'duplicate'
              ? 'The _id is removed, so the server makes a new one.'
              : 'Values use EJSON, so ObjectId, dates and Long values keep their types.'}
          </Text>
          <JsonEditor
            label="Document as EJSON"
            height={360}
            value={text}
            onChange={(value) => {
              setText(value);
              setError(undefined);
            }}
          />
          {error === undefined ? null : (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={busy} type="submit">
              {SAVE_LABELS[mode]}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
