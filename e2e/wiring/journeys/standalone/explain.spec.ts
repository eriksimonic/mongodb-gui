import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

interface PlanNode {
  readonly stage: string;
  readonly indexName?: string;
  readonly inputStage?: PlanNode;
  readonly inputStages?: readonly PlanNode[];
}

interface PlanExplain {
  readonly queryPlanner: {
    // Newer servers wrap the classic tree in queryPlan.
    readonly winningPlan: PlanNode & { readonly queryPlan?: PlanNode };
  };
}

interface PlanStep {
  readonly name: string;
  readonly indexName: string | undefined;
}

// Walks the winning plan in the order the explain view lists its stages.
function winningSteps(node: PlanNode, steps: PlanStep[] = []): PlanStep[] {
  steps.push({ name: node.stage, indexName: node.indexName });
  for (const child of [node.inputStage, ...(node.inputStages ?? [])]) {
    if (child !== undefined) {
      winningSteps(child, steps);
    }
  }
  return steps;
}

test('explain, assert the winning plan stage', async ({ page, wiring }) => {
  await page.goto(wiring.url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  await page.getByRole('treeitem', { name: 'shop', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open editor', exact: true }).click();
  // A click on the role textbox did not focus the editor. The visible lines do.
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.insertText("db.orders.find({ status: 'paid' })");
  await page.getByRole('button', { name: 'Explain', exact: true }).click();

  // Read the plan through a second client, so the check does not trust the UI.
  const client = new MongoClient(mongoUriFromEnv());
  let steps: PlanStep[];
  try {
    const explain = (await client
      .db('shop')
      .collection('orders')
      .find({ status: 'paid' })
      .explain('queryPlanner')) as unknown as PlanExplain;
    const winning = explain.queryPlanner.winningPlan;
    steps = winningSteps(winning.queryPlan ?? winning);
  } finally {
    await client.close();
  }
  const names = steps.map((step) => step.name);
  // Fails if the seed index is missing, since the plan would then have no IXSCAN.
  expect(names).toContain('IXSCAN');
  expect(steps.map((step) => step.indexName)).toContain('status_1');

  // The plan opens in the graph view. The list view has the stages as text.
  // The radio input is hidden, so the click goes to its visible label text.
  await page
    .getByRole('radiogroup', { name: 'Plan view' })
    .getByText('List', { exact: true })
    .click();
  const tree = page.getByRole('tree', { name: 'Plan stages' });
  const items = tree.getByRole('treeitem');
  await expect(items).toHaveCount(names.length);
  for (const [index, name] of names.entries()) {
    await expect(items.nth(index)).toContainText(name);
  }
  await expect(tree.getByText('status_1', { exact: true })).toBeVisible();
});
