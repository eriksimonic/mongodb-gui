import { Box, Group, Stack, Tabs, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { CollectionStats } from '@mongo-gui/core';
import { useUiApi } from '../api/ui-api';
import { useAppStore } from '../state/app-store-context';
import { ChangesPanel } from '../changes';
import { CollectionStatsPanel } from '../diagnostics';
import { formatBytes } from '../kit/input-rules';
import { DocumentsPanel, IndexesPanel, ValidationPanel } from '../management';
import { SchemaPanel } from '../schema';

export type CollectionSection = 'documents' | 'indexes' | 'validation' | 'schema' | 'changes' | 'stats';

export interface CollectionPanelProps {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly section: CollectionSection;
  readonly onSectionChange?: (section: CollectionSection) => void;
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <Stack gap={0} align="flex-end">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" ff="monospace">
        {value}
      </Text>
    </Stack>
  );
}

/** One tab per collection: a header with the storage stats and the section tabs. */
export function CollectionPanel({
  connectionId,
  database,
  collection,
  section,
  onSectionChange,
}: CollectionPanelProps) {
  const { rpc } = useUiApi();
  const revision = useAppStore((state) => state.catalogRevision);
  const [stats, setStats] = useState<CollectionStats | undefined>(undefined);
  const [active, setActive] = useState<CollectionSection>(section);

  const [seenSection, setSeenSection] = useState(section);
  if (seenSection !== section) {
    setSeenSection(section);
    setActive(section);
  }

  useEffect(() => {
    let current = true;
    rpc.diagnostics.collStats({ connectionId, database, collection }).then(
      (result) => {
        if (current) {
          setStats(result);
        }
      },
      () => {
        if (current) {
          setStats(undefined);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [rpc, connectionId, database, collection, revision]);

  const params = { connectionId, database, collection };
  return (
    <Stack gap={0} h="100%" style={{ overflow: 'hidden' }}>
      <Group justify="space-between" align="flex-start" px="md" pt="md" wrap="nowrap">
        <Stack gap={2}>
          <Text ff="monospace" fw={600} size="lg">
            {database}.{collection}
          </Text>
          <Text size="xs" c="dimmed">
            {stats?.capped === true ? 'Capped collection' : 'Collection'}
          </Text>
        </Stack>
        {stats === undefined ? null : (
          <Group gap="lg" wrap="nowrap">
            <Stat label="Documents" value={stats.count.toLocaleString('en-US')} />
            <Stat label="Data size" value={formatBytes(stats.size)} />
            <Stat label="Storage size" value={formatBytes(stats.storageSize)} />
            <Stat label="Index size" value={formatBytes(stats.totalIndexSize)} />
            <Stat label="Avg document" value={formatBytes(stats.avgObjSize)} />
          </Group>
        )}
      </Group>
      <Tabs className="mg-tab-separators"
        value={active}
        onChange={(value) => {
          if (value !== null) {
            const next = value as CollectionSection;
            setActive(next);
            onSectionChange?.(next);
          }
        }}
        keepMounted={false}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        <Tabs.List px="md" mt="sm">
          <Tabs.Tab value="documents">Documents</Tabs.Tab>
          <Tabs.Tab
            value="indexes"
            rightSection={
              stats === undefined ? null : (
                <Text size="xs" c="dimmed">
                  {stats.nindexes}
                </Text>
              )
            }
          >
            Indexes
          </Tabs.Tab>
          <Tabs.Tab value="validation">Validation</Tabs.Tab>
          <Tabs.Tab value="schema">Analyse</Tabs.Tab>
          <Tabs.Tab value="changes">Watch</Tabs.Tab>
          <Tabs.Tab value="stats">Collection stats</Tabs.Tab>
        </Tabs.List>
        <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <Tabs.Panel value="documents">
            <DocumentsPanel {...params} />
          </Tabs.Panel>
          <Tabs.Panel value="indexes">
            <IndexesPanel {...params} />
          </Tabs.Panel>
          <Tabs.Panel value="validation">
            <ValidationPanel {...params} />
          </Tabs.Panel>
          <Tabs.Panel value="schema" h="100%">
            <SchemaPanel {...params} />
          </Tabs.Panel>
          <Tabs.Panel value="changes" h="100%">
            <Box h="100%" style={{ minHeight: 400 }}>
              <ChangesPanel
                panelId={`collection-changes:${connectionId}:${database}.${collection}`}
                connectionId={connectionId}
                target={{ kind: 'collection', database, collection }}
              />
            </Box>
          </Tabs.Panel>
          <Tabs.Panel value="stats">
            <CollectionStatsPanel {...params} />
          </Tabs.Panel>
        </Box>
      </Tabs>
    </Stack>
  );
}
