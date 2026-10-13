import type { Meta, StoryObj } from '@storybook/react-vite';
import type { BackupProgress } from '@mongo-gui/core';
import { AppRoot } from '../AppRoot';
import { createMockUiApi } from '../api/mock-rpc-client';
import { BackupProgressView } from './BackupProgressView';
import type { BackupJobView } from './use-backup-job';

const base: BackupProgress = {
  phase: 'running',
  documents: 0,
  bytes: 0,
  active: [],
  finishedNamespaces: 0,
  failedDocuments: 0,
  lines: [],
  warnings: [],
  elapsedMs: 0,
  done: false,
  cancelled: false,
};

function viewOf(progress: Partial<BackupProgress>, lines: string[] = []): BackupJobView {
  return { progress: { ...base, ...progress }, lines, warnings: progress.warnings ?? [] };
}

const meta: Meta<typeof BackupProgressView> = {
  title: 'Backup/BackupProgressView',
  component: BackupProgressView,
  args: { kind: 'dump', onCancel: () => undefined },
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked' })}>
        <div style={{ width: 640, padding: 16 }}>
          <Story />
        </div>
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

/** A dump in progress with two active collections and a warning. */
export const Running: Story = {
  args: {
    view: viewOf(
      {
        documents: 48_000,
        totalDocuments: 120_000,
        bytes: 9_400_000,
        fraction: 0.4,
        finishedNamespaces: 3,
        totalNamespaces: 8,
        elapsedMs: 6200,
        active: [
          { namespace: 'shop.orders', documents: 30_000, total: 80_000 },
          { namespace: 'shop.events', documents: 18_000 },
        ],
        warnings: ['shop.events: collection has no index on _id'],
      },
      ['writing shop.orders to archive', 'shop.orders  30000'],
    ),
  },
};

/** A finished archive dump with its checksum. */
export const DumpDone: Story = {
  args: {
    view: viewOf(
      {
        phase: 'finished',
        done: true,
        documents: 120_000,
        finishedNamespaces: 8,
        bytes: 24_000_000,
        elapsedMs: 15_300,
        result: {
          kind: 'dump',
          outputPath: '/home/user/backups/shop.archive.gz',
          sidecarPath: '/home/user/backups/shop.archive.gz.json',
          bytes: 24_000_000,
          sha256: 'c0ffee00112233445566778899aabbccddeeff00112233445566778899aabbcc',
          documents: 120_000,
          namespaces: 8,
        },
      },
      ['done dumping shop.orders (80000 documents)'],
    ),
  },
};

/** A restore where some documents were refused. */
export const RestoreWithFailures: Story = {
  args: {
    kind: 'restore',
    view: viewOf({
      phase: 'finished',
      done: true,
      documents: 1200,
      failedDocuments: 14,
      finishedNamespaces: 3,
      elapsedMs: 4100,
      result: {
        kind: 'restore',
        dryRun: false,
        restored: 1186,
        failed: 14,
        databases: ['shop'],
        plan: [],
      },
    }),
  },
};

/** A dry run lists what would be written. */
export const DryRun: Story = {
  args: {
    kind: 'restore',
    view: viewOf({
      phase: 'finished',
      done: true,
      result: {
        kind: 'restore',
        dryRun: true,
        restored: 0,
        failed: 0,
        databases: ['shop_copy'],
        plan: [
          { from: 'shop.orders', to: 'shop_copy.orders' },
          { from: 'shop.customers', to: 'shop_copy.customers' },
        ],
      },
    }),
  },
};
