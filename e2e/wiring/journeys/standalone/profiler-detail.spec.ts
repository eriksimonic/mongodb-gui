import type { Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

// The profiler journey covers enabling the profiler and the first entry. These cover the rest of the tab.

interface PlanNode {
  readonly stage: string;
  readonly indexName?: string;
  readonly inputStage?: PlanNode;
  readonly inputStages?: readonly PlanNode[];
}

interface PlanStep {
  readonly name: string;
  readonly indexName: string | undefined;
}

/** Walks the winning plan in the order the explain view lists its stages. */
function winningSteps(node: PlanNode, steps: PlanStep[] = []): PlanStep[] {
  steps.push({ name: node.stage, indexName: node.indexName });
  for (const child of [node.inputStage, ...(node.inputStages ?? [])]) {
    if (child !== undefined) {
      winningSteps(child, steps);
    }
  }
  return steps;
}

/** Connects Local dev and opens the profiler of one database. */
async function openProfiler(page: Page, url: string, database: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  await page.getByRole('treeitem', { name: database, exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Monitoring', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Open profiler', exact: true }).click();
}

/** Picks a level in the segmented control, then Apply. Waits until the server has the level. */
async function applyLevel(page: Page, level: 'Off' | 'All'): Promise<void> {
  await page
    .getByRole('radiogroup', { name: 'Profiling level' })
    .getByText(level, { exact: true })
    .click();
  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  await apply.click();
  await expect(apply).toBeDisabled();
}

test('profiler: query shapes tab counts the executions of one shape', async ({ page, wiring }) => {
  const DATABASE = 'profiler_detail_shapes';
  const COMMENT = 'profiler-detail-shapes';
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client.db(DATABASE).dropDatabase();
    await client
      .db(DATABASE)
      .collection('items')
      .insertMany([0, 1, 2].map((n) => ({ marker: 'profiler-detail', n })));

    await openProfiler(page, wiring.url, DATABASE);
    await applyLevel(page, 'All');

    // Three runs of one find shape. The comment keeps the runs apart from other operations.
    for (let run = 0; run < 3; run += 1) {
      await client
        .db(DATABASE)
        .collection('items')
        .find({ marker: 'profiler-detail' })
        .comment(COMMENT)
        .toArray();
    }

    // The server writes each profile entry before the find returns, so no wait is needed here.
    const executions = await client
      .db(DATABASE)
      .collection('system.profile')
      .countDocuments({ ns: `${DATABASE}.items`, op: 'query', 'command.comment': COMMENT });
    expect(executions).toBe(3);

    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('tab', { name: 'Top shapes', exact: true }).click();

    // Each shape row is labelled with its namespace and op. The first cell is the count.
    const row = page.getByRole('row', { name: `Shape ${DATABASE}.items query` });
    await expect(row).toBeVisible();
    await expect(row.getByRole('cell').first()).toHaveText(String(executions));
  } finally {
    await client.db(DATABASE).command({ profile: 0 });
    await client.close();
  }
});

test('profiler: select a slow query, see its namespace, command and metrics', async ({
  page,
  wiring,
}) => {
  const DATABASE = 'profiler_detail_entry';
  const COMMENT = 'profiler-detail-entry';
  const NAMESPACE = `${DATABASE}.items`;
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client.db(DATABASE).dropDatabase();
    await client
      .db(DATABASE)
      .collection('items')
      .insertMany([0, 1, 2].map((n) => ({ marker: 'profiler-detail', n })));

    await openProfiler(page, wiring.url, DATABASE);
    await applyLevel(page, 'All');

    await client
      .db(DATABASE)
      .collection('items')
      .find({ marker: 'profiler-detail' })
      .comment(COMMENT)
      .toArray();

    // The server holds one entry with the comment. Its metrics are what the detail pane should show.
    const profiled = await client
      .db(DATABASE)
      .collection('system.profile')
      .findOne({ ns: NAMESPACE, 'command.comment': COMMENT });
    expect(profiled).not.toBeNull();

    await page.getByRole('textbox', { name: 'Text search', exact: true }).fill(COMMENT);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();

    const grid = page.getByRole('grid', { name: 'Slow operations', exact: true });
    const row = grid
      .getByRole('row')
      .filter({ has: page.getByRole('gridcell', { name: NAMESPACE, exact: true }) });
    await expect(row).toHaveCount(1);
    await row.click();

    // The detail pane is the element after the resize splitter. Scope the checks to it, so the grid cell does not count.
    const pane = page
      .getByRole('separator', { name: 'Resize the detail pane', exact: true })
      .locator('xpath=following-sibling::div[1]');
    await expect(pane.getByText(NAMESPACE, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Explain', exact: true })).toBeEnabled();

    // Monaco does not expose its text by role, so the editor lines are read directly.
    await expect(page.locator('.monaco-editor .view-lines').first()).toContainText(COMMENT);

    // The label and value are siblings. Scope to the parent so the value is not matched elsewhere.
    await expect(pane.getByText('Docs examined', { exact: true }).locator('..')).toContainText(
      String(profiled?.['docsExamined']),
    );
  } finally {
    await client.db(DATABASE).command({ profile: 0 });
    await client.close();
  }
});

test('profiler: explain a profiled operation, match the side-channel plan', async ({
  page,
  wiring,
}) => {
  const DATABASE = 'profiler_detail_explain';
  const COMMENT = 'profiler-detail-explain';
  const INDEX = 'profiler_detail_status';
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client.db(DATABASE).dropDatabase();
    // One paid order among many, so an index scan is the cheapest plan.
    await client
      .db(DATABASE)
      .collection('orders')
      .insertMany(
        Array.from({ length: 100 }, (_, n) => ({ n, status: n === 0 ? 'paid' : 'open' })),
      );
    await client.db(DATABASE).collection('orders').createIndex({ status: 1 }, { name: INDEX });

    await openProfiler(page, wiring.url, DATABASE);
    await applyLevel(page, 'All');

    await client
      .db(DATABASE)
      .collection('orders')
      .find({ status: 'paid' })
      .comment(COMMENT)
      .toArray();

    await page.getByRole('textbox', { name: 'Text search', exact: true }).fill(COMMENT);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();

    const grid = page.getByRole('grid', { name: 'Slow operations', exact: true });
    const row = grid
      .getByRole('row')
      .filter({ has: page.getByRole('gridcell', { name: `${DATABASE}.orders`, exact: true }) });
    await expect(row).toHaveCount(1);
    await row.click();
    await page.getByRole('button', { name: 'Explain', exact: true }).click();

    // Explain the same find on the server, through a second client, and list its stages in order.
    const explain = (await client
      .db(DATABASE)
      .collection('orders')
      .find({ status: 'paid' })
      .comment(COMMENT)
      .explain('queryPlanner')) as unknown as {
      queryPlanner: { winningPlan: PlanNode & { queryPlan?: PlanNode } };
    };
    const steps = winningSteps(
      explain.queryPlanner.winningPlan.queryPlan ?? explain.queryPlanner.winningPlan,
    );
    expect(steps.map((step) => step.name)).toContain('IXSCAN');
    expect(steps.map((step) => step.indexName)).toContain(INDEX);

    // The plan opens in the graph view. The list view has the stages as text.
    // The explain panel is up once its plan view control shows. Wait on that before the list click.
    const planView = page.getByRole('radiogroup', { name: 'Plan view' });
    await expect(planView).toBeVisible();
    await planView.getByText('List', { exact: true }).click();
    const tree = page.getByRole('tree', { name: 'Plan stages' });
    const items = tree.getByRole('treeitem');
    await expect(items).toHaveCount(steps.length);
    for (const [index, step] of steps.entries()) {
      await expect(items.nth(index)).toContainText(step.name);
    }
    await expect(tree.getByText(INDEX, { exact: true })).toBeVisible();
  } finally {
    await client.db(DATABASE).command({ profile: 0 });
    await client.close();
  }
});

test('profiler: live tail shows a new entry without Refresh', async ({ page, wiring }) => {
  const DATABASE = 'profiler_detail_tail';
  const COMMENT = 'profiler-detail-tail';
  const NAMESPACE = `${DATABASE}.items`;
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client.db(DATABASE).dropDatabase();
    await client
      .db(DATABASE)
      .collection('items')
      .insertMany([0, 1, 2].map((n) => ({ marker: 'profiler-detail', n })));

    await openProfiler(page, wiring.url, DATABASE);
    await applyLevel(page, 'All');

    const grid = page.getByRole('grid', { name: 'Slow operations', exact: true });
    const rows = grid
      .getByRole('row')
      .filter({ has: page.getByRole('gridcell', { name: NAMESPACE, exact: true }) });
    await expect(rows).toHaveCount(0);

    // Mantine draws the track over the switch input, so pointer clicks do not reach it. A user
    // toggles it with Space after focusing it, and the test does the same.
    const tail = page.getByRole('switch', { name: 'Tail', exact: true });
    await tail.focus();
    await page.keyboard.press('Space');
    await expect(tail).toBeChecked();

    await client
      .db(DATABASE)
      .collection('items')
      .find({ marker: 'profiler-detail' })
      .comment(COMMENT)
      .toArray();

    // The tail polls the server, so the row arrives on its own. The UI waits for it.
    const profiled = await client
      .db(DATABASE)
      .collection('system.profile')
      .countDocuments({ ns: NAMESPACE, 'command.comment': COMMENT });
    expect(profiled).toBe(1);
    await expect(rows).toHaveCount(profiled);
  } finally {
    await client.db(DATABASE).command({ profile: 0 });
    await client.close();
  }
});

test('profiler: level Off through the tab sets the server level to 0', async ({ page, wiring }) => {
  const DATABASE = 'profiler_detail_off';
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client.db(DATABASE).dropDatabase();
    await client
      .db(DATABASE)
      .collection('items')
      .insertMany([0, 1, 2].map((n) => ({ marker: 'profiler-detail', n })));
    // Start at level 2 on the server, so the tab has a level to turn off.
    await client.db(DATABASE).command({ profile: 2 });

    await openProfiler(page, wiring.url, DATABASE);
    await applyLevel(page, 'Off');

    // profile: -1 changes nothing. Its reply holds the level before the call, which must be 0 now.
    const level = await client.db(DATABASE).command({ profile: -1 });
    expect(level['was']).toBe(0);
    await expect(page.getByText('Server level:', { exact: false })).toContainText('Off');
  } finally {
    await client.db(DATABASE).command({ profile: 0 });
    await client.close();
  }
});
