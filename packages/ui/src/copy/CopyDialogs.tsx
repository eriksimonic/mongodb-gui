import { Alert, Button, Group, Modal, Stack } from '@mantine/core';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { useAppStore } from '../state/app-store-context';
import { catalogKey } from '../state/node-ids';
import { errorText, runReported } from '../kit/notify-error';
import { CopyDialog } from './CopyDialog';
import { CopyProgressView } from './CopyProgressView';
import { useCopyDialogs, type CopyDialogRequest } from './copy-dialog-store';
import { isCopyable } from './copy-model';

/** Renders the copy dialog and the progress view while the store holds them. */
export function CopyDialogs() {
  const request = useCopyDialogs((state) => state.request);
  const jobId = useCopyDialogs((state) => state.jobId);
  return (
    <>
      {request === undefined ? null : <CopyRequestDialog request={request} />}
      {jobId === undefined ? null : <CopyProgressDialog jobId={jobId} />}
    </>
  );
}

/** The copy dialog for one request. A database request waits for its collection list first. */
function CopyRequestDialog({ request }: { readonly request: CopyDialogRequest }) {
  const close = useCopyDialogs((state) => state.close);
  const showJob = useCopyDialogs((state) => state.showJob);
  const loadCollections = useAppStore((state) => state.loadCollections);
  const { connectionId, database, variant } = request;
  const catalog = useAppStore((state) => state.collections[catalogKey(connectionId, database)]);

  useEffect(() => {
    if (variant === 'database') {
      void loadCollections(connectionId, database);
    }
  }, [variant, connectionId, database, loadCollections]);

  // The dialog builds its rows once, from the collections it gets on mount. Wait for the list.
  if (request.variant === 'one') {
    return (
      <CopyDialog
        sourceConnectionId={connectionId}
        sourceDatabase={database}
        variant="one"
        collections={[request.collection]}
        onStarted={showJob}
        onClose={close}
      />
    );
  }
  if (catalog?.state === 'error') {
    return (
      <Modal opened onClose={close} title={`Copy database ${database}`} centered>
        <Stack gap="md">
          <Alert color="red" role="alert">
            {errorText(catalog.error)}
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Close
            </Button>
          </Group>
        </Stack>
      </Modal>
    );
  }
  if (catalog?.state !== 'ready') {
    return null;
  }
  return (
    <CopyDialog
      sourceConnectionId={connectionId}
      sourceDatabase={database}
      variant="database"
      collections={catalog.data.filter(isCopyable).map((item) => item.name)}
      onStarted={showJob}
      onClose={close}
    />
  );
}

/**
 * The progress of one job. While the job runs the modal has no close control, as the backup
 * dialog, so Cancel is the only way out. Close appears when the job ends.
 */
function CopyProgressDialog({ jobId }: { readonly jobId: string }) {
  const closeJob = useCopyDialogs((state) => state.closeJob);
  const copies = useAppStore((state) => state.copies);
  const job = useStore(copies, (state) => state.jobs[jobId]);
  const finished = job?.result !== undefined;
  return (
    <Modal
      opened
      onClose={closeJob}
      title="Copy progress"
      size="xl"
      centered
      closeOnClickOutside={finished}
      closeOnEscape={finished}
      withCloseButton={finished}
    >
      <Stack gap="md">
        <CopyProgressView
          job={job}
          onCancel={() => {
            void runReported(() => copies.getState().cancel(jobId));
          }}
        />
        {finished ? (
          <Group justify="flex-end">
            <Button onClick={closeJob}>Close</Button>
          </Group>
        ) : null}
      </Stack>
    </Modal>
  );
}
