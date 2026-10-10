import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { localConnectionId } from '../api/mock-fixtures';
import {
  errorExplainPanel,
  loadingExplainPanel,
  mockExplainPanel,
  mockExplainPanelFromRaw,
  rawFixture,
  refusedExplainPanel,
  withFailedShard,
} from '../api/explain-fixture-panels';
import { connectedMockApi } from '../api/connected-mock';
import type { UiApi } from '../api/ui-api';
import { AppRoot } from '../AppRoot';
import type { ExplainPanelState } from './explain-model';
import { ExplainPanel } from './ExplainPanel';

/** Seeds the store with one finished panel, and uses a connected mock so Re-run works. */
function withPanel(panel: ExplainPanelState): Decorator {
  return (Story, context) => (
    <div style={{ height: 760, width: 1000, padding: 8 }}>
      <AppRoot
        api={context.loaded.api as UiApi}
        initialState={{ explainPanels: { [panel.id]: panel } }}
      >
        <Story />
      </AppRoot>
    </div>
  );
}

const meta: Meta<typeof ExplainPanel> = {
  title: 'Explain/ExplainPanel',
  component: ExplainPanel,
  loaders: [async () => ({ api: await connectedMockApi() })],
};

export default meta;

type Story = StoryObj<typeof meta>;

const FIND = `db.orders.find({ status: 'paid' }).sort({ total: -1 })`;

/** A classic find that sorts in memory. The warning points at the SORT stage. */
const classicFind = mockExplainPanel({
  id: 'explain:classic-find',
  connectionId: localConnectionId,
  database: 'shop',
  code: FIND,
  fixture: '8.0.17/in-memory-sort',
  collection: 'orders',
});

export const ClassicFindInMemorySort: Story = {
  args: { panelId: classicFind.id },
  decorators: [withPanel(classicFind)],
};

/** An aggregate on the slot-based engine. The engine badge reads sbe. */
const sbeAggregate = mockExplainPanel({
  id: 'explain:sbe-aggregate',
  connectionId: localConnectionId,
  database: 'shop',
  code: `db.orders.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: '$customerId', total: { $sum: '$total' } } }])`,
  fixture: '6.0-sbe/aggregate-group',
  collection: 'orders',
});

export const SlotBasedAggregate: Story = {
  args: { panelId: sbeAggregate.id },
  decorators: [withPanel(sbeAggregate)],
};

/** A find on a sharded cluster. Each shard has its own subtree under a heading. */
const shardedFind = mockExplainPanel({
  id: 'explain:sharded-find',
  connectionId: localConnectionId,
  database: 'shop',
  code: FIND,
  fixture: 'sharded/find-sort',
  collection: 'orders',
});

export const ShardedFind: Story = {
  args: { panelId: shardedFind.id },
  decorators: [withPanel(shardedFind)],
};

/** A collection scan with a warning. The warning points at the COLLSCAN stage. */
const collscan = mockExplainPanel({
  id: 'explain:collscan',
  connectionId: localConnectionId,
  database: 'shop',
  code: `db.orders.find({ total: { $gt: 100 } })`,
  fixture: '8.0.17/collscan',
  collection: 'orders',
});

export const CollscanWithWarnings: Story = {
  args: { panelId: collscan.id },
  decorators: [withPanel(collscan)],
};

/** The explain is still running. The panel shows the loading state. */
const loading = loadingExplainPanel({
  id: 'explain:loading',
  connectionId: localConnectionId,
  database: 'shop',
  code: FIND,
  collection: 'orders',
});

export const Loading: Story = {
  args: { panelId: loading.id },
  decorators: [withPanel(loading)],
};

/** The server refused the explain. The panel shows the error text. */
const failed = errorExplainPanel({
  id: 'explain:error',
  connectionId: localConnectionId,
  database: 'shop',
  code: FIND,
  collection: 'orders',
  error: {
    code: 'COMMAND_FAILED',
    message: 'The explain failed.',
    detail: 'Index build in progress on orders.',
  },
});

export const ExplainError: Story = {
  args: { panelId: failed.id },
  decorators: [withPanel(failed)],
};

/** A statement with two writes is refused before it runs. The panel shows the reason. */
const refused = refusedExplainPanel({
  id: 'explain:refused',
  connectionId: localConnectionId,
  database: 'shop',
  code: 'db.orders.find({}); db.orders.find({})',
  message: 'Explain needs one collection query',
});

export const Refused: Story = {
  args: { panelId: refused.id },
  decorators: [withPanel(refused)],
};

/** Two indexes compete for the query. The rejected plan is listed under its own heading. */
const rejected = mockExplainPanel({
  id: 'explain:rejected',
  connectionId: localConnectionId,
  database: 'shop',
  code: `db.orders.find({ customerId: 7, status: 'paid' })`,
  fixture: '8.0.17/competing',
  verbosity: 'allPlansExecution',
  collection: 'orders',
});

export const RejectedPlans: Story = {
  args: { panelId: rejected.id },
  decorators: [withPanel(rejected)],
};

/** One story per fixture family, so each shape can be checked by eye in both themes. */
function familyPanel(id: string, fixture: string, code: string): ExplainPanelState {
  return mockExplainPanel({
    id: `explain:${id}`,
    connectionId: localConnectionId,
    database: 'shop',
    code,
    fixture,
    collection: 'orders',
  });
}

const ixscanFetch = familyPanel(
  'ixscan-fetch',
  '8.0.17/ixscan-sort',
  `db.orders.find({ customerId: 7 }).sort({ createdAt: -1 })`,
);

/** An index scan with a fetch. The fetch shows the examined to returned ratio. */
export const IxscanWithFetch: Story = {
  args: { panelId: ixscanFetch.id },
  decorators: [withPanel(ixscanFetch)],
};

const sortSpill = familyPanel(
  'sort-spill',
  '8.0.17/sort-spill',
  `db.orders.find({}).sort({ total: -1, createdAt: 1 })`,
);

/** A sort that spills to disk. The spill counters are highlighted. */
export const SortSpilling: Story = {
  args: { panelId: sortSpill.id },
  decorators: [withPanel(sortSpill)],
};

const groupSpill = familyPanel(
  'group-spill',
  '8.0.17/group-spill',
  `db.orders.aggregate([{ $group: { _id: '$items.sku', total: { $sum: '$total' } } }])`,
);

/** A group that spills to disk, on the slot-based engine. */
export const GroupSpilling: Story = {
  args: { panelId: groupSpill.id },
  decorators: [withPanel(groupSpill)],
};

const lookupPipeline = familyPanel(
  'lookup-pipeline',
  '8.0.17/lookup-pipeline',
  `db.orders.aggregate([{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', pipeline: [{ $match: { active: true } }], as: 'customer' } }])`,
);

/** A $lookup with an inner pipeline. The inner pipeline is an open sub-tree under its label. */
export const LookupInnerPipeline: Story = {
  args: { panelId: lookupPipeline.id },
  decorators: [withPanel(lookupPipeline)],
};

const facet = familyPanel(
  'facet',
  '8.0.17/facet',
  `db.orders.aggregate([{ $facet: { byStatus: [{ $group: { _id: '$status', n: { $sum: 1 } } }], empty: [], total: [{ $count: 'n' }] } }])`,
);

/** A $facet with one branch per name. The empty branch shows as a pass-through node. */
export const FacetBranches: Story = {
  args: { panelId: facet.id },
  decorators: [withPanel(facet)],
};

const unionWith = familyPanel(
  'union-with',
  '8.0.17/union-with',
  `db.orders.aggregate([{ $unionWith: { coll: 'archived_orders', pipeline: [{ $match: { status: 'paid' } }] } }])`,
);

/** A $unionWith. Each input is a sub-tree labelled with its collection. */
export const UnionWith: Story = {
  args: { panelId: unionWith.id },
  decorators: [withPanel(unionWith)],
};

const shardedError = mockExplainPanelFromRaw({
  id: 'explain:sharded-error',
  connectionId: localConnectionId,
  database: 'shop',
  code: FIND,
  collection: 'orders',
  raw: withFailedShard(
    rawFixture('sharded/find-sort', 'executionStats'),
    'shard02 is not reachable',
  ),
});

/** A sharded find where one shard failed. The failed shard shows its error in red. */
export const ShardedWithErrorShard: Story = {
  args: { panelId: shardedError.id },
  decorators: [withPanel(shardedError)],
};

const textSearch = familyPanel(
  'text',
  '8.0.17/text-search',
  `db.orders.find({ $text: { $search: 'gift card' } })`,
);

/** A text search. The TEXT_MATCH stage shows its own metrics. */
export const TextSearch: Story = {
  args: { panelId: textSearch.id },
  decorators: [withPanel(textSearch)],
};

const geo = familyPanel(
  'geo',
  '8.0.17/geo-2dsphere',
  `db.orders.aggregate([{ $geoNear: { near: { type: 'Point', coordinates: [14.5, 46.05] }, distanceField: 'dist' } }])`,
);

/** A geo near query on a 2dsphere index. */
export const GeoNear: Story = {
  args: { panelId: geo.id },
  decorators: [withPanel(geo)],
};

const express = familyPanel('express', '8.0.17/express-unique', `db.orders.find({ _id: 7 })`);

/** A query the 8.0 express path answers without the classic planner. */
export const ExpressPath: Story = {
  args: { panelId: express.id },
  decorators: [withPanel(express)],
};

const unknownShape = mockExplainPanelFromRaw({
  id: 'explain:unknown-shape',
  connectionId: localConnectionId,
  database: 'shop',
  code: FIND,
  collection: 'orders',
  raw: { ok: 1, weirdShape: { nested: [1, 2, { deep: true }] } },
});

/** A document with no plan. The Raw tab still shows it, with search and copy. */
export const UnknownShape: Story = {
  args: { panelId: unknownShape.id },
  decorators: [withPanel(unknownShape)],
};
