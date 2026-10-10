import type { ConnectionProfileSummary, ConnectionStatus, GridFsBucket } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import {
  catalogKey,
  connectionNodeId,
  databaseNodeId,
  gridfsBucketNodeId,
  gridfsNodeId,
} from '../../state/node-ids';
import { buildTreeRows, type TreeInput, type TreeRow } from './tree-model';

const connection: ConnectionProfileSummary = {
  id: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10',
  name: 'Local dev',
  color: undefined,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  uriRedacted: 'mongodb://app:***@localhost/',
};
const connected: ConnectionStatus = {
  state: 'connected',
  serverVersion: '8.0.4',
  topology: 'standalone',
  hosts: [],
};
const receipts: GridFsBucket = {
  name: 'receipts',
  filesCollection: 'receipts.files',
  chunksCollection: 'receipts.chunks',
  fileCount: 4,
  totalBytes: 355_000,
};

function treeWith(gridfsExpanded: boolean, buckets: TreeInput['gridfs']): TreeRow[] {
  return buildTreeRows({
    connections: [connection],
    statuses: { [connection.id]: connected },
    expanded: {
      [connectionNodeId(connection.id)]: true,
      [databaseNodeId(connection.id, 'shop')]: true,
      ...(gridfsExpanded ? { [gridfsNodeId(connection.id, 'shop')]: true } : {}),
    },
    databases: {
      [connection.id]: { state: 'ready', data: [{ name: 'shop', sizeOnDisk: 0, empty: false }] },
    },
    collections: {},
    gridfs: buckets,
  });
}

describe('tree rows for GridFS', () => {
  it('shows a GridFS node under an open database, collapsed by default', () => {
    const rows = treeWith(false, {});
    const node = rows.find((row) => row.kind === 'gridfs');

    expect(node).toMatchObject({ label: 'GridFS', expandable: true, expanded: false });
    expect(node?.key).toBe(gridfsNodeId(connection.id, 'shop'));
    expect(rows.some((row) => row.kind === 'gridfs-bucket')).toBe(false);
  });

  it('lists each bucket with its file count and total size under the open node', () => {
    const rows = treeWith(true, {
      [catalogKey(connection.id, 'shop')]: { state: 'ready', data: [receipts] },
    });
    const bucket = rows.find((row) => row.kind === 'gridfs-bucket');

    expect(bucket).toMatchObject({
      key: gridfsBucketNodeId(connection.id, 'shop', 'receipts'),
      label: 'receipts · 4 files · 346.7 KiB',
      bucket: 'receipts',
      database: 'shop',
      depth: 3,
    });
  });

  it('says so when the database has no buckets, and while they load', () => {
    const empty = treeWith(true, {
      [catalogKey(connection.id, 'shop')]: { state: 'ready', data: [] },
    });
    expect(empty.some((row) => row.label === 'No buckets')).toBe(true);

    const loading = treeWith(true, {});
    expect(loading.some((row) => row.label === 'Loading buckets')).toBe(true);
  });
});
