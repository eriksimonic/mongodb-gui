import { expect, test, type Page } from '@playwright/test';
import {
  Binary,
  Code,
  Decimal128,
  Double,
  Int32,
  Long,
  MongoClient,
  ObjectId,
  Timestamp,
} from 'mongodb';
import {
  closeWindowAndWaitForExit,
  createUserDataDir,
  expectCleanLogs,
  forceClose,
  launchApp,
  removeUserDataDir,
  type AppSession,
} from '../support/app';
import { mongoUriFromEnv } from '../support/mongo';

const MASTER_PASSWORD = 'correct horse battery staple';
const CONNECTION_NAME = 'E2E Mongo';
const DEVTOOLS_PORT = 9235;
const DOCUMENT_COUNT = 300;
const DOCS_DIR = `${process.cwd()}/docs/screenshots`;

test('editor, results, paging, tree edit, print, history and favourites, end to end', async () => {
  const uri = mongoUriFromEnv();
  const seeded = await seedNestedOrders(uri);
  const userDataDir = await createUserDataDir();
  let session: AppSession | undefined;
  try {
    session = await launchApp(userDataDir, [`--remote-debugging-port=${DEVTOOLS_PORT}`]);
    const window = session.window;

    await test.step('create the vault', async () => {
      await window.getByLabel('Master password', { exact: true }).fill(MASTER_PASSWORD);
      await window.getByLabel('Confirm master password', { exact: true }).fill(MASTER_PASSWORD);
      await window.getByRole('button', { name: 'Create vault' }).click();
      await expect(window.getByRole('button', { name: 'Lock', exact: true })).toBeVisible();
    });

    await test.step('add the connection and connect', async () => {
      await window.getByRole('button', { name: 'New connection' }).first().click();
      const dialog = window.getByRole('dialog', { name: 'New connection' });
      await dialog.getByLabel('Name', { exact: true }).fill(CONNECTION_NAME);
      await dialog.getByLabel('Connection URI').fill(uri);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).toBeHidden();
      await treeItem(window, CONNECTION_NAME).dblclick();
      await expect(window.getByLabel('Connected', { exact: true })).toBeVisible();
    });

    await test.step('expand the connection and double-click the shop database', async () => {
      await treeItem(window, CONNECTION_NAME).focus();
      await window.keyboard.press('ArrowRight');
      await expect(treeItem(window, 'shop')).toBeVisible();
      await treeItem(window, 'shop').dblclick();
      await expect(window.getByRole('textbox', { name: 'Query for shop' })).toBeVisible();
    });

    await test.step('type the query and see field completion', async () => {
      await window.locator('.monaco-editor .view-lines').first().click();
      await window.keyboard.press('Control+A');
      await window.keyboard.press('Delete');
      await window.keyboard.type('db.orders.', { delay: 60 });
      await expect(window.locator('.suggest-widget').first()).toBeVisible();
      await window.keyboard.press('Escape');
      await window.keyboard.type('find({ status: "paid" }).sort({ total: -1 })', { delay: 15 });
    });

    await test.step('run with Ctrl+Enter and read the first page', async () => {
      await window.keyboard.press('Control+Enter');
      await expect(window.getByText(/^1 to \d+ of \?$/)).toBeVisible();
    });

    await test.step('page to the end', async () => {
      const more = window.getByRole('button', { name: 'Load more' });
      for (let guard = 0; guard < 20; guard += 1) {
        if (await more.isDisabled()) {
          break;
        }
        await more.click();
        await window.waitForTimeout(150);
      }
      const expectedPaid = await seeded.paid;
      await expect(window.getByText(`1 to ${expectedPaid} of ${expectedPaid}`)).toBeVisible();
    });

    await test.step('switch the table, tree and JSON views', async () => {
      await viewSwitch(window, 'tree').click();
      await expect(window.getByRole('tree', { name: 'Document tree' })).toBeVisible();
      await window.getByRole('button', { name: 'Collapse all' }).click();
      await window.getByRole('button', { name: 'Expand #1', exact: true }).click();
      await window.screenshot({ path: `${DOCS_DIR}/editor-tree.png`, animations: 'disabled' });

      await viewSwitch(window, 'json').click();
      await expect(window.locator('.monaco-editor').nth(1).locator('.view-lines')).toContainText(
        'ORD-',
      );
      await window.screenshot({ path: `${DOCS_DIR}/editor-json.png`, animations: 'disabled' });

      await viewSwitch(window, 'table').click();
      await expect(window.getByRole('button', { name: /^Columns / })).toBeVisible();
      await window.screenshot({ path: `${DOCS_DIR}/editor-table.png`, animations: 'disabled' });
    });

    await test.step('edit the first document status in the tree and check the server', async () => {
      await viewSwitch(window, 'tree').click();
      await window.getByRole('button', { name: 'Expand #1', exact: true }).click();
      await window.getByRole('button', { name: 'Edit status', exact: true }).click();
      const input = window.getByRole('textbox', { name: 'New value for status' });
      await input.fill('shipped');
      await input.press('Enter');
      await expect(window.getByRole('textbox', { name: 'New value for status' })).toBeHidden();
      await expect.poll(() => seeded.statusOf(seeded.topPaidId)).toBe('shipped');
      await viewSwitch(window, 'table').click();
    });

    await test.step('print and count with Run all, and read the print line in Output', async () => {
      await window.locator('.monaco-editor .view-lines').first().click();
      await window.keyboard.press('Control+A');
      await window.keyboard.press('Delete');
      await window.keyboard.type('print("hi"); db.orders.countDocuments()', { delay: 10 });
      await window.keyboard.press('Control+Shift+Enter');
      const log = window.getByRole('log', { name: 'Output' });
      await expect(log.getByText('hi', { exact: true })).toBeVisible();
    });

    await test.step('the history records the runs', async () => {
      await window.getByRole('tab', { name: 'History' }).click();
      await expect(
        window
          .getByTestId('history-panel')
          .getByText(/db\.orders\.find/)
          .first(),
      ).toBeVisible();
      await window.screenshot({ path: `${DOCS_DIR}/history.png`, animations: 'disabled' });
    });

    await test.step('save the query as a favourite', async () => {
      await window.locator('.monaco-editor .view-lines').first().click();
      await window.keyboard.press('Control+A');
      await window.keyboard.press('Delete');
      await window.keyboard.type('db.orders.find({ status: "paid" })', { delay: 10 });
      await window
        .locator('.mg-editor-toolbar')
        .getByRole('button', { name: 'Save as favourite' })
        .click();
      await window.getByRole('textbox', { name: 'Name' }).fill('Paid orders');
      await window.getByRole('textbox', { name: 'Folder' }).fill('Sales');
      await window.getByRole('button', { name: 'Save', exact: true }).click();
      await window.getByRole('tab', { name: 'Favourites' }).click();
      await expect(window.getByText('Paid orders')).toBeVisible();
    });

    await test.step('closing the window quits the app cleanly', async () => {
      const app = session as AppSession;
      const exitCode = await closeWindowAndWaitForExit(app);
      expect(exitCode).toBe(0);
      expectCleanLogs(app);
    });
  } finally {
    if (session !== undefined) {
      await forceClose(session);
    }
    await removeUserDataDir(userDataDir);
    await seeded.close();
  }
});

/** The view switch labels. Mantine hides the radio inputs, so the label is the click target. */
function viewSwitch(window: Page, view: 'table' | 'tree' | 'json') {
  return window.locator(`label[for$="-${view}"]`);
}

function treeItem(window: Page, name: string) {
  return window.getByRole('treeitem', { name, exact: true });
}

interface SeededOrders {
  readonly paid: Promise<number>;
  readonly topPaidId: ObjectId;
  statusOf(id: ObjectId): Promise<string | undefined>;
  close(): Promise<void>;
}

/**
 * Replaces shop.orders with 300 nested documents that use every BSON type the views label. The
 * client is the driver, which the app uses too, so the checks read what the server stores.
 */
async function seedNestedOrders(uri: string): Promise<SeededOrders> {
  const client = new MongoClient(uri);
  await client.connect();
  const orders = client.db('shop').collection('orders');
  await orders.deleteMany({});
  const docs = Array.from({ length: DOCUMENT_COUNT }, (_, index) => {
    const seed = index + 1;
    return {
      _id: new ObjectId(seed.toString(16).padStart(24, '0')),
      status: seed % 3 === 0 ? 'open' : 'paid',
      reference: `ORD-${String(seed).padStart(5, '0')}`,
      total: Long.fromNumber(seed * 1000),
      quantity: new Int32((seed % 9) + 1),
      ratio: new Double((seed % 10) / 10 + 0.5),
      price: Decimal128.fromString(`${seed}.25`),
      express: seed % 2 === 0,
      discountCode: seed % 4 === 0 ? null : 'SPRING',
      createdAt: new Date(Date.UTC(2026, 0, 1) + seed * 3_600_000),
      correlation: new Binary(Buffer.alloc(16, seed % 255), Binary.SUBTYPE_UUID),
      sequence: new Timestamp({ t: 1_768_465_800 + seed, i: seed % 5 }),
      pattern: /^ORD-/i,
      script: new Code('return 1'),
      tags: ['web', seed % 3 === 0 ? 'gift' : 'standard'],
      customer: {
        name: `Customer ${seed}`,
        address: {
          city: seed % 2 === 0 ? 'Ljubljana' : 'Maribor',
          geo: { lat: 46.05, lng: 14.51 },
        },
      },
      lines: [
        { sku: 'A-100', qty: new Int32(2), unit: Decimal128.fromString('9.99') },
        { sku: 'B-240', qty: new Int32((seed % 3) + 1), unit: Decimal128.fromString('24.50') },
      ],
    };
  });
  await orders.insertMany(docs);
  const top = await orders.find({ status: 'paid' }).sort({ total: -1 }).limit(1).toArray();
  const topPaidId = top[0]?._id as ObjectId;
  const paid = orders.countDocuments({ status: 'paid' });
  return {
    paid,
    topPaidId,
    statusOf: async (id) => (await orders.findOne({ _id: id }))?.status as string | undefined,
    close: () => client.close(),
  };
}
