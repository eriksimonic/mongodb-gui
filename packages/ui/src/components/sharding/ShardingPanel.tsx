import { Alert, Badge, Button, Group, Stack, Tabs, Text } from '@mantine/core';
import type { BalancerWindow } from '@mongo-gui/core';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { useUiApi } from '../../api/ui-api';
import { createShardingStore, type ShardingStore } from '../../sharding/sharding-store';
import { DestructiveDialog } from '../management/DestructiveDialog';
import { DistributionDialog } from './DistributionDialog';
import { CollectionsTable, DatabasesTable, ShardsTable, ZonesTable } from './ShardingTables';

export interface ShardingPanelProps {
  readonly connectionId: string;
}

type PanelTab = 'shards' | 'databases' | 'collections' | 'zones';

/** A change the user must confirm before the panel makes it. */
type PendingChange =
  | { readonly kind: 'balancer'; readonly enabled: boolean }
  | { readonly kind: 'enableSharding'; readonly database: string };

const TABS: readonly PanelTab[] = ['shards', 'databases', 'collections', 'zones'];

function isPanelTab(value: string | null): value is PanelTab {
  return TABS.some((tab) => tab === value);
}

/** A window whose end is before its start runs past midnight, and the text says so. */
function windowText(window: BalancerWindow): string {
  const wraps = window.stop < window.start;
  return `${window.start} to ${window.stop}${wraps ? ' (wraps midnight)' : ''}`;
}

/** The text after the balancer badge says whether a round runs and what the window is. */
function balancerDetail(inRound: boolean, window: BalancerWindow | undefined): string {
  const round = inRound ? 'a round is running' : undefined;
  const hours = window === undefined ? 'no balancer window' : `window ${windowText(window)}`;
  return [round, hours].filter((part) => part !== undefined).join(', ');
}

/**
 * The sharding panel of one connection. It reads the cluster overview from the mongos and shows
 * the shards, databases, sharded collections and zones. The balancer buttons and the enable
 * sharding action ask for confirmation first.
 */
export function ShardingPanel({ connectionId }: ShardingPanelProps) {
  const { rpc, onEvent } = useUiApi();
  const [store] = useState<ShardingStore>(() => createShardingStore(connectionId, rpc.sharding));
  const overview = useStore(store, (state) => state.overview);
  const loadError = useStore(store, (state) => state.loadError);
  const loading = useStore(store, (state) => state.loading);
  const [tab, setTab] = useState<PanelTab>('shards');
  const [pending, setPending] = useState<PendingChange | undefined>(undefined);
  const [distributionOf, setDistributionOf] = useState<string | undefined>(undefined);

  useEffect(() => {
    void store.getState().load();
    // A shard or a database changed elsewhere in the app, so the overview reloads.
    return onEvent((event) => {
      if (event.type === 'catalog:changed' && event.connectionId === connectionId) {
        void store.getState().load();
      }
    });
  }, [store, onEvent, connectionId]);

  const sharded = overview?.isSharded === true;
  const balancerOn = overview?.balancer?.mode === 'full';

  return (
    <Stack gap="xs" p="sm">
      {loading && overview === undefined ? (
        <Text size="sm" c="dimmed">
          Loading the cluster
        </Text>
      ) : null}
      {loadError === undefined ? null : (
        <Alert color="red" variant="light">
          {loadError}
        </Alert>
      )}
      {overview !== undefined && !sharded ? (
        <Alert color="gray" variant="light" title="Sharding is not available">
          This server is not a mongos or a sharded cluster. Connect to a mongos to manage shards.
        </Alert>
      ) : null}
      {sharded && overview !== undefined ? (
        <>
          <Group justify="space-between" wrap="wrap">
            <Stack gap={2}>
              <Group gap="xs">
                <Badge color={balancerOn ? 'teal' : 'gray'} variant="light">
                  {balancerOn ? 'Balancer on' : 'Balancer off'}
                </Badge>
                <Text size="sm" c="dimmed">
                  {balancerDetail(
                    overview.balancer?.inBalancerRound === true,
                    overview.balancer?.activeWindow,
                  )}
                </Text>
              </Group>
              <Text size="xs" c="dimmed">
                {overview.mongosHost === undefined ? '' : `mongos ${overview.mongosHost}`}
              </Text>
            </Stack>
            <Group gap="xs">
              <Button
                variant="default"
                size="xs"
                disabled={balancerOn}
                onClick={() => setPending({ kind: 'balancer', enabled: true })}
              >
                Start balancer
              </Button>
              <Button
                variant="default"
                size="xs"
                disabled={!balancerOn}
                onClick={() => setPending({ kind: 'balancer', enabled: false })}
              >
                Stop balancer
              </Button>
            </Group>
          </Group>
          <Tabs
            value={tab}
            onChange={(value) => {
              if (isPanelTab(value)) {
                setTab(value);
              }
            }}
          >
            <Tabs.List>
              <Tabs.Tab value="shards">Shards</Tabs.Tab>
              <Tabs.Tab value="databases">Databases</Tabs.Tab>
              <Tabs.Tab value="collections">Collections</Tabs.Tab>
              <Tabs.Tab value="zones">Zones</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="shards">
              <ShardsTable shards={overview.shards} />
            </Tabs.Panel>
            <Tabs.Panel value="databases">
              <DatabasesTable
                databases={overview.databases}
                onEnable={(database) => setPending({ kind: 'enableSharding', database })}
              />
            </Tabs.Panel>
            <Tabs.Panel value="collections">
              <CollectionsTable
                collections={overview.collections}
                shards={overview.shards}
                onDistribution={(namespace) => setDistributionOf(namespace)}
              />
            </Tabs.Panel>
            <Tabs.Panel value="zones">
              <ZonesTable zones={overview.zones} />
            </Tabs.Panel>
          </Tabs>
        </>
      ) : null}
      {pending === undefined ? null : (
        <DestructiveDialog
          title={
            pending.kind === 'balancer'
              ? pending.enabled
                ? 'Start the balancer'
                : 'Stop the balancer'
              : 'Enable sharding'
          }
          description={describeChange(pending)}
          confirmLabel={
            pending.kind === 'balancer'
              ? pending.enabled
                ? 'Start balancer'
                : 'Stop balancer'
              : 'Enable sharding'
          }
          confirmColor="blue"
          onClose={() => setPending(undefined)}
          onConfirm={async () => {
            if (pending.kind === 'balancer') {
              await store.getState().setBalancer(pending.enabled);
            } else {
              await store.getState().enableSharding(pending.database);
            }
          }}
        />
      )}
      {distributionOf === undefined ? null : (
        <DistributionDialog
          store={store}
          namespace={distributionOf}
          onClose={() => setDistributionOf(undefined)}
        />
      )}
    </Stack>
  );
}

/** The plain summary the confirmation shows before the change. */
function describeChange(change: PendingChange): string {
  if (change.kind === 'enableSharding') {
    return `Enable sharding on ${change.database}. Collections in it can then be sharded. Enabling sharding moves no data.`;
  }
  return change.enabled
    ? 'Start the balancer. Chunks move between shards again, within the balancer window if one is set.'
    : 'Stop the balancer. No chunks move between shards until it starts again. A round that is already running finishes first.';
}
