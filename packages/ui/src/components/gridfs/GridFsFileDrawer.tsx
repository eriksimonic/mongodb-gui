import { Button, Code, Drawer, Group, Stack, Table, Text } from '@mantine/core';
import type { GridFsFile } from '@mongo-gui/core';
import { formatBytes, formatMetadata, formatUploadDate } from './gridfs-model';

export interface GridFsFileDrawerProps {
  readonly file: GridFsFile;
  readonly onDownload: () => void;
  readonly onRename: () => void;
  readonly onEditMetadata: () => void;
  readonly onDelete: () => void;
  readonly onClose: () => void;
}

/** Every field of one file, with the metadata as formatted JSON and the same actions as the table. */
export function GridFsFileDrawer({
  file,
  onDownload,
  onRename,
  onEditMetadata,
  onDelete,
  onClose,
}: GridFsFileDrawerProps) {
  const rows: Array<readonly [string, string]> = [
    ['Id', file.idEjson],
    ['Name', file.filename],
    ['Size', `${formatBytes(file.length)} (${file.length.toLocaleString('en-US')} bytes)`],
    ['Chunk size', formatBytes(file.chunkSize)],
    ['Upload date', formatUploadDate(file.uploadDate)],
    ['Content type', file.contentType ?? 'Not set'],
    ['MD5', file.md5 ?? 'Not stored'],
  ];
  return (
    <Drawer opened onClose={onClose} title={file.filename} position="right" size="md">
      <Stack gap="md">
        <Table>
          <Table.Tbody>
            {rows.map(([label, value]) => (
              <Table.Tr key={label}>
                <Table.Th w={130}>{label}</Table.Th>
                <Table.Td style={{ wordBreak: 'break-all' }}>
                  <Text size="sm" ff="monospace">
                    {value}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Metadata
          </Text>
          <Code block aria-label="Metadata as JSON">
            {formatMetadata(file.metadataEjson)}
          </Code>
        </Stack>
        <Group gap="xs">
          <Button size="xs" variant="default" onClick={onDownload}>
            Download
          </Button>
          <Button size="xs" variant="default" onClick={onRename}>
            Rename
          </Button>
          <Button size="xs" variant="default" onClick={onEditMetadata}>
            Edit metadata
          </Button>
          <Button size="xs" color="red" variant="light" onClick={onDelete}>
            Delete
          </Button>
        </Group>
      </Stack>
    </Drawer>
  );
}
