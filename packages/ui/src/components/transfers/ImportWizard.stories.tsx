import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AppRoot } from '../../AppRoot';
import { localConnectionId } from '../../api/mock-fixtures';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { mockImportPreview } from '../../api/mock-transfer';
import {
  ImportSummary,
  ImportWizardBody,
  MappingStep,
  OptionsStep,
  ChooseFileStep,
} from './ImportWizard';
import { DEFAULT_IMPORT_DRAFT, mappingRowsFrom } from './import-model';

const meta: Meta<typeof ImportWizardBody> = {
  title: 'Transfers/ImportWizard',
  component: ImportWizardBody,
  args: { connectionId: localConnectionId, database: 'shop', collection: 'orders', onClose: fn() },
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked' })}>
        <div style={{ width: 760, padding: 16 }}>
          <Story />
        </div>
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

/** The first step, with a file picked and the CSV options open. */
export const ChooseFile: Story = {
  args: {},
};

/** The first step creating a new collection, with the name still empty. */
export const NewCollection: Story = {
  args: { collection: undefined },
};

const preview = mockImportPreview();

/** The preview and mapping step: warnings, one row per field with an editable target, and the sample rows. */
export const MappingStepView: StoryObj<typeof MappingStep> = {
  render: () => (
    <MappingStep
      preview={preview}
      rows={mappingRowsFrom(preview)}
      problems={[]}
      onRowsChange={fn()}
    />
  ),
};

/** The same step with a target clash, which blocks Next. */
export const MappingStepWithProblem: StoryObj<typeof MappingStep> = {
  render: () => {
    const rows = mappingRowsFrom(preview).map((row, index) =>
      index === 2 ? { ...row, target: 'order_id' } : row,
    );
    return (
      <MappingStep
        preview={preview}
        rows={rows}
        problems={[{ field: 'mapping', message: 'Two fields are mapped to "order_id"' }]}
        onRowsChange={fn()}
      />
    );
  },
};

/** The options step in insert mode. */
export const OptionsStepView: StoryObj<typeof OptionsStep> = {
  render: () => (
    <OptionsStep
      draft={{ ...DEFAULT_IMPORT_DRAFT, path: '/mock/orders.csv' }}
      target="shop.orders"
      rowCount={preview.estimatedRows}
      problems={[]}
      onChange={fn()}
    />
  ),
};

/** The first step with its form values, for a file chosen by the path field. */
export const ChooseFileStepView: StoryObj<typeof ChooseFileStep> = {
  render: () => (
    <ChooseFileStep
      draft={{ ...DEFAULT_IMPORT_DRAFT, path: '/mock/orders.csv' }}
      collectionIsNew={false}
      database="shop"
      target="orders"
      onChange={fn()}
      onBrowse={fn()}
    />
  ),
};

/** The summary of an import that stopped with two row errors. */
export const Summary: StoryObj<typeof ImportSummary> = {
  render: () => (
    <ImportSummary
      progress={{
        processed: 240,
        inserted: 238,
        updated: 0,
        matched: 0,
        failed: 2,
        elapsedMs: 2000,
        done: true,
        errors: [{ row: 12, message: '"n/a" is not a number' }],
        warnings: [],
      }}
      database="shop"
      collection="orders"
      onOpen={fn()}
      onAgain={fn()}
      onClose={fn()}
    />
  ),
};
