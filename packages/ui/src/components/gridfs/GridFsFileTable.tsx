import { ActionIcon, Badge, Checkbox, Code, Tooltip } from '@mantine/core';
import { IconCode, IconDownload, IconPencil, IconTrash } from '@tabler/icons-react';
import type { GridFsFile } from '@mongo-gui/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, type CSSProperties } from 'react';
import { formatBytes, formatMetadata, formatUploadDate, metadataFieldCount } from './gridfs-model';

const ROW_HEIGHT_PX = 36;
const OVERSCAN_ROWS = 8;
const GRID_COLUMNS = '32px minmax(180px, 2fr) 90px 90px 170px minmax(110px, 1fr) 110px 120px';
/** The file name looks like text and opens the detail drawer when clicked. */
const NAME_BUTTON_STYLE: CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export interface GridFsFileTableProps {
  readonly files: readonly GridFsFile[];
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (idEjson: string) => void;
  readonly onToggleAll: () => void;
  readonly onOpen: (idEjson: string) => void;
  readonly onDownload: (file: GridFsFile) => void;
  readonly onRename: (file: GridFsFile) => void;
  readonly onEditMetadata: (file: GridFsFile) => void;
  readonly onDelete: (file: GridFsFile) => void;
}

/**
 * The files of a bucket in a virtualised table. Only the rows in view are rendered, so a bucket
 * with thousands of files scrolls as smoothly as one with ten.
 */
export function GridFsFileTable({
  files,
  selected,
  onToggle,
  onToggleAll,
  onOpen,
  onDownload,
  onRename,
  onEditMetadata,
  onDelete,
}: GridFsFileTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: OVERSCAN_ROWS,
  });
  const allSelected = files.length > 0 && files.every((file) => selected.has(file.idEjson));
  const someSelected = files.some((file) => selected.has(file.idEjson));

  return (
    <div
      role="table"
      aria-label="Files"
      aria-rowcount={files.length + 1}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
    >
      <div
        role="row"
        className="mg-gridfs-row mg-gridfs-head"
        style={{ display: 'grid', gridTemplateColumns: GRID_COLUMNS, alignItems: 'center' }}
      >
        <div role="columnheader">
          <Checkbox
            aria-label="Select all files"
            checked={allSelected}
            indeterminate={!allSelected && someSelected}
            onChange={onToggleAll}
            size="xs"
          />
        </div>
        <div role="columnheader">Name</div>
        <div role="columnheader">Size</div>
        <div role="columnheader">Chunk size</div>
        <div role="columnheader">Uploaded</div>
        <div role="columnheader">Content type</div>
        <div role="columnheader">Metadata</div>
        <div role="columnheader">Actions</div>
      </div>
      <div
        ref={scrollRef}
        className="mg-gridfs-scroll"
        style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const file = files[item.index];
            if (file === undefined) {
              return null;
            }
            return (
              <div
                key={file.idEjson}
                role="row"
                aria-selected={selected.has(file.idEjson)}
                className="mg-gridfs-row"
                data-testid="gridfs-file-row"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: ROW_HEIGHT_PX,
                  transform: `translateY(${item.start}px)`,
                  display: 'grid',
                  gridTemplateColumns: GRID_COLUMNS,
                  alignItems: 'center',
                  borderBottom: '1px solid var(--mantine-color-dark-5)',
                }}
              >
                <div role="gridcell">
                  <Checkbox
                    aria-label={`Select ${file.filename}`}
                    checked={selected.has(file.idEjson)}
                    onChange={() => onToggle(file.idEjson)}
                    size="xs"
                  />
                </div>
                <div role="gridcell" style={{ minWidth: 0 }}>
                  <button
                    type="button"
                    style={NAME_BUTTON_STYLE}
                    onClick={() => onOpen(file.idEjson)}
                    title={file.filename}
                  >
                    {file.filename}
                  </button>
                </div>
                <div role="gridcell">{formatBytes(file.length)}</div>
                <div role="gridcell">{formatBytes(file.chunkSize)}</div>
                <div role="gridcell">{formatUploadDate(file.uploadDate)}</div>
                <div role="gridcell" style={{ minWidth: 0 }}>
                  {file.contentType ?? '-'}
                </div>
                <div role="gridcell">
                  <MetadataBadge file={file} />
                </div>
                <div role="gridcell" style={{ display: 'flex', gap: 4 }}>
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    aria-label={`Download ${file.filename}`}
                    onClick={() => onDownload(file)}
                  >
                    <IconDownload size={14} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    aria-label={`Rename ${file.filename}`}
                    onClick={() => onRename(file)}
                  >
                    <IconPencil size={14} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    aria-label={`Edit metadata of ${file.filename}`}
                    onClick={() => onEditMetadata(file)}
                  >
                    <IconCode size={14} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    color="red"
                    aria-label={`Delete ${file.filename}`}
                    onClick={() => onDelete(file)}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The number of metadata fields, with the whole JSON in a tooltip on hover or focus. */
function MetadataBadge({ file }: { readonly file: GridFsFile }) {
  const count = metadataFieldCount(file);
  if (count === 0) {
    return (
      <Badge variant="light" color="gray" size="sm">
        None
      </Badge>
    );
  }
  return (
    <Tooltip
      multiline
      w={360}
      withArrow
      label={<Code block>{formatMetadata(file.metadataEjson)}</Code>}
    >
      <Badge variant="light" color="blue" size="sm" tabIndex={0}>
        {count === 1 ? '1 field' : `${count} fields`}
      </Badge>
    </Tooltip>
  );
}
