import { MongoClient, type Document } from 'mongodb';
import type { Page } from '@playwright/test';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

const EXEC_DB = 'explain_more_exec';
const SCAN_DB = 'explain_more_scan';
const AGG_DB = 'explain_more_agg';
const RAW_DB = 'explain_more_raw';

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

interface ExecutionExplain {
  readonly executionStats: {
    readonly nReturned: number;
    readonly totalKeysExamined: number;
    readonly totalDocsExamined: number;
  };
}

// Walks a classic plan tree in the order the explain view lists its stages.
function planSteps(node: PlanNode, steps: PlanStep[] = []): PlanStep[] {
  steps.push({ name: node.stage, indexName: node.indexName });
  for (const child of [node.inputStage, ...(node.inputStages ?? [])]) {
    if (child !== undefined) {
      planSteps(child, steps);
    }
  }
  return steps;
}

// An aggregate explain nests the find plan under stages[].$cursor, so search for the first
// winningPlan instead of reading a fixed path.
function findWinningPlan(node: unknown): PlanNode | undefined {
  if (typeof node !== 'object' || node === null) {
    return undefined;
  }
  if ('winningPlan' in node) {
    const winning = node.winningPlan as PlanNode & { readonly queryPlan?: PlanNode };
    return winning.queryPlan ?? winning;
  }
  for (const value of Object.values(node)) {
    const found = findWinningPlan(value);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

// Each label in the summary bar is a dt, and its value is the dd after it.
function summaryValue(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator('xpath=following-sibling::dd');
}

async function openEditor(page: Page, url: string, database: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  await page.getByRole('treeitem', { name: database, exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open editor', exact: true }).click();
}

async function explainFromEditor(page: Page, code: string): Promise<void> {
  // A click on the role textbox did not focus the editor. The visible lines do.
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.insertText(code);
  await page.getByRole('button', { name: 'Explain', exact: true }).click();
}

// Drops the database and inserts the same three items. No index, so a find on color scans.
async function seedItems(client: MongoClient, database: string): Promise<void> {
  await client.db(database).dropDatabase();
  await client
    .db(database)
    .collection('items')
    .insertMany([
      { color: 'red', size: 1 },
      { color: 'blue', size: 2 },
      { color: 'red', size: 3 },
    ]);
}

test('explain with executionStats, counts match the server', async ({ page, wiring }) => {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    const orders = client.db(EXEC_DB).collection('orders');
    await client.db(EXEC_DB).dropDatabase();
    await orders.insertMany([
      { orderNumber: 1, status: 'paid' },
      { orderNumber: 2, status: 'open' },
      { orderNumber: 3, status: 'paid' },
    ]);
    await orders.createIndex({ status: 1 }, { name: 'status_1' });

    await openEditor(page, wiring.url, EXEC_DB);
    await explainFromEditor(page, "db.orders.find({ status: 'paid' })");
    // The first explain already runs with executionStats. Switching to queryPlanner first
    // shows the counts are gone, so the executionStats click is a real rerun.
    const verbosity = page.getByRole('radiogroup', { name: 'Verbosity' });
    await verbosity.getByText('Plan only', { exact: true }).click();
    await expect(summaryValue(page, 'Returned')).toHaveText('-');
    await verbosity.getByText('With stats', { exact: true }).click();

    const explain = (await orders
      .find({ status: 'paid' })
      .explain('executionStats')) as unknown as ExecutionExplain;
    const stats = explain.executionStats;
    await expect(summaryValue(page, 'Returned')).toHaveText(String(stats.nReturned));
    await expect(summaryValue(page, 'Keys examined')).toHaveText(String(stats.totalKeysExamined));
    await expect(summaryValue(page, 'Docs examined')).toHaveText(String(stats.totalDocsExamined));
  } finally {
    await client.close();
  }
});

test('explain a find with no index, the plan is a collection scan', async ({ page, wiring }) => {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await seedItems(client, SCAN_DB);

    await openEditor(page, wiring.url, SCAN_DB);
    await explainFromEditor(page, "db.items.find({ color: 'red' })");
    await expect(summaryValue(page, 'Index')).toHaveText('Collection scan');

    const explain = (await client
      .db(SCAN_DB)
      .collection('items')
      .find({ color: 'red' })
      .explain('queryPlanner')) as unknown as Document;
    const winning = findWinningPlan(explain);
    const names = planSteps(winning ?? { stage: 'missing' }).map((step) => step.name);
    // The side-channel plan has a scan and no index, so the UI can only say collection scan.
    expect(names).toContain('COLLSCAN');
    expect(names).not.toContain('IXSCAN');

    await page
      .getByRole('radiogroup', { name: 'Plan view' })
      .getByText('List', { exact: true })
      .click();
    const tree = page.getByRole('tree', { name: 'Plan stages' });
    await expect(tree.getByRole('treeitem').filter({ hasText: 'COLLSCAN' })).toHaveCount(1);
    await expect(tree.getByRole('treeitem').filter({ hasText: 'IXSCAN' })).toHaveCount(0);
  } finally {
    await client.close();
  }
});

test('explain an aggregate, the stage matches the server plan', async ({ page, wiring }) => {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await seedItems(client, AGG_DB);

    await openEditor(page, wiring.url, AGG_DB);
    // The $replaceRoot stays in the pipeline after the planner pushes the $match down. A plain
    // find explain has no such stage, so this check cannot pass on a find.
    const pipeline = [{ $match: { color: 'red' } }, { $replaceRoot: { newRoot: { c: '$color' } } }];
    await explainFromEditor(
      page,
      "db.items.aggregate([{ $match: { color: 'red' } }, { $replaceRoot: { newRoot: { c: '$color' } } }])",
    );

    const explain = (await client
      .db(AGG_DB)
      .collection('items')
      .aggregate(pipeline)
      .explain('queryPlanner')) as unknown as Document;
    const winning = findWinningPlan(explain);
    expect(winning, 'the aggregate explain has a winning plan').toBeDefined();
    const serverStage = winning?.stage ?? '';
    // Each entry in stages[] is one pipeline stage, keyed by its name, such as $cursor.
    const serverStages = (explain.stages as Document[]).map((stage) => Object.keys(stage)[0] ?? '');
    expect(serverStages).toContain('$replaceRoot');

    await page
      .getByRole('radiogroup', { name: 'Plan view' })
      .getByText('List', { exact: true })
      .click();
    const tree = page.getByRole('tree', { name: 'Plan stages' });
    await expect(tree.getByRole('treeitem').filter({ hasText: serverStage })).not.toHaveCount(0);
    for (const name of serverStages) {
      await expect(tree.getByRole('treeitem').filter({ hasText: name })).not.toHaveCount(0);
    }
  } finally {
    await client.close();
  }
});

test('explain raw view shows the winning plan stage', async ({ page, wiring }) => {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await seedItems(client, RAW_DB);

    await openEditor(page, wiring.url, RAW_DB);
    await explainFromEditor(page, "db.items.find({ color: 'red' })");
    await expect(summaryValue(page, 'Index')).toHaveText('Collection scan');

    const explain = (await client
      .db(RAW_DB)
      .collection('items')
      .find({ color: 'red' })
      .explain('queryPlanner')) as unknown as Document;
    const serverStage = findWinningPlan(explain)?.stage ?? '';
    expect(serverStage).toBe('COLLSCAN');

    await page.getByRole('tab', { name: 'Raw', exact: true }).click();
    // Monaco renders only the lines near the top, and the stage sits further down. The raw
    // search finds it and scrolls the editor to the match, so the line is then rendered.
    await page.getByRole('textbox', { name: 'Search raw output' }).fill(serverStage);
    await expect(page.getByText(/^1 of \d+$/)).toBeVisible();
    await expect(page.locator('.monaco-editor .view-lines').first()).toContainText(serverStage);
  } finally {
    await client.close();
  }
});
