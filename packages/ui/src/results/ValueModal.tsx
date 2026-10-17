import { Alert, Button, Group, Loader, Modal, Stack } from '@mantine/core';
import { IconCopy } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { ReadOnlyCode } from '../kit/code/ReadOnlyCode';
import { copyText } from '../kit/copy';
import { errorText } from '../kit/notify-error';

export interface ValueModalProps {
  /** The field's dotted path, shown as the title. */
  readonly path: string;
  /** Reads the full text of the value. */
  readonly load: () => Promise<string>;
  readonly onClose: () => void;
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'error'; readonly message: string };

/** One field's full value, read-only, with a copy action. Opens for a value the grid shortens. */
export function ValueModal({ path, load, onClose }: ValueModalProps) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    load().then(
      (text) => live && setLoaded({ kind: 'text', text }),
      (failure: unknown) => live && setLoaded({ kind: 'error', message: errorText(failure) }),
    );
    return () => {
      live = false;
    };
  }, [load]);

  return (
    <Modal opened onClose={onClose} title={path} centered size="min(1100px, 94vw)">
      <Stack gap="sm">
        <div style={{ height: 420 }}>
          {loaded.kind === 'loading' ? (
            <Group justify="center" h="100%">
              <Loader size="sm" />
            </Group>
          ) : loaded.kind === 'error' ? (
            <Alert color="red">{loaded.message}</Alert>
          ) : (
            <ReadOnlyCode label={`Value of ${path}`} value={loaded.text} language="json" wrap />
          )}
        </div>
        <Group justify="flex-end">
          <Button
            variant="default"
            leftSection={<IconCopy size={13} />}
            disabled={loaded.kind !== 'text'}
            onClick={() => {
              if (loaded.kind === 'text') {
                void copyText(loaded.text, 'Value copied');
              }
            }}
          >
            Copy
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
