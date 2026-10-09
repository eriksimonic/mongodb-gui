import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { localConnectionId } from '../api/mock-fixtures';
import {
  errorExplainPanel,
  loadingExplainPanel,
  mockExplainPanel,
  refusedExplainPanel,
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
