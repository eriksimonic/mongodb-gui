import { ActionIcon, Button, SegmentedControl } from '@mantine/core';
import {
  type ConditionOperator,
  type FieldInfo,
  GROUP_OPERATORS,
  type GroupOperator,
  type QueryGroup,
  type QueryItem,
} from '@mongo-gui/core';
import { IconFolderPlus, IconPlus, IconTrash } from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';
import { ConditionRow, RawItemRow } from './ConditionRow';
import { elemMatchScope, newCondition } from './condition-model';

const GROUP_LABELS: Record<GroupOperator, string> = { and: 'AND', or: 'OR', nor: 'NOR' };
/** The Mantine colour of the operator pill. The rail in `builder.css` uses the matching token. */
const GROUP_COLORS: Record<GroupOperator, string> = { and: 'brand', or: 'blue', nor: 'red' };

let lastKey = 0;

function nextKey(): number {
  lastKey += 1;
  return lastKey;
}

export interface GroupEditorProps {
  readonly group: QueryGroup;
  /**
   * The fields the items can use, in the scope of this group. A nested `$elemMatch` group gets the
   * fields of its array, with their names relative to the array element.
   */
  readonly fields: readonly FieldInfo[];
  /** True for the group of an `$elemMatch` over scalars. It has one field and no nested groups. */
  readonly scalarElement?: boolean | undefined;
  readonly onChange: (group: QueryGroup) => void;
  /** Set for a nested group. The top group has no delete. */
  readonly onDelete?: (() => void) | undefined;
}

/**
 * A group of conditions joined by AND, OR or NOR, with its items in order. It is controlled: the
 * parent holds the group and receives every change as a new group.
 */
export function GroupEditor({
  group,
  fields,
  scalarElement = false,
  onChange,
  onDelete,
}: GroupEditorProps) {
  // Each item keeps a key, so an input keeps its own text when the items before it change. The
  // handlers below keep the keys in step with the items.
  const [keys, setKeys] = useState<number[]>(() => group.items.map(() => nextKey()));
  const keyAt = (index: number): number | string => keys[index] ?? `new-${index}`;

  /** The operators of the other conditions. Pass -1 to take every condition. */
  const takenBy = (index: number): ConditionOperator[] =>
    group.items.flatMap((item, position) =>
      position === index || item.kind !== 'condition' ? [] : [item.operator],
    );

  const nextCondition = newCondition(fields, scalarElement, takenBy(-1));

  const replaceAt = (index: number, item: QueryItem): void => {
    onChange({
      ...group,
      items: group.items.map((old, position) => (position === index ? item : old)),
    });
  };

  const removeAt = (index: number): void => {
    setKeys(keys.filter((_, position) => position !== index));
    onChange({ ...group, items: group.items.filter((_, position) => position !== index) });
  };

  const copyAt = (index: number): void => {
    const item = group.items[index];
    if (item === undefined) {
      return;
    }
    setKeys([...keys.slice(0, index + 1), nextKey(), ...keys.slice(index + 1)]);
    onChange({
      ...group,
      items: [...group.items.slice(0, index + 1), item, ...group.items.slice(index + 1)],
    });
  };

  const add = (item: QueryItem): void => {
    setKeys([...keys, nextKey()]);
    onChange({ ...group, items: [...group.items, item] });
  };

  const renderItem = (item: QueryItem, index: number) => {
    const replace = (next: QueryItem): void => replaceAt(index, next);
    const remove = (): void => removeAt(index);
    const copy = (): void => copyAt(index);

    if (item.kind === 'group') {
      return <GroupEditor group={item} fields={fields} onChange={replace} onDelete={remove} />;
    }
    if (item.kind === 'rawCondition' || item.kind === 'rawFragment') {
      return (
        <RawItemRow
          item={item}
          onChange={replace}
          onCopy={copy}
          onDelete={remove}
          copyDisabled={scalarElement}
        />
      );
    }
    const scope =
      item.operator === 'elemMatch'
        ? elemMatchScope(fields, item.field, item.group.items)
        : undefined;
    return (
      <>
        <ConditionRow
          item={item}
          fields={fields}
          scalarElement={scalarElement}
          takenOperators={scalarElement ? takenBy(index) : undefined}
          onChange={replace}
          onCopy={copy}
          onDelete={remove}
        />
        {item.operator === 'elemMatch' && scope !== undefined && (
          <div className="mg-qb-nested">
            <GroupEditor
              group={item.group}
              fields={scope.fields}
              scalarElement={scope.scalarElement}
              onChange={(next) => replace({ ...item, group: next })}
            />
          </div>
        )}
      </>
    );
  };

  const nested = onDelete !== undefined;
  let hint: ReactNode = null;
  if (group.items.length === 0) {
    hint = nested ? (
      <span className="mg-qb-hint">No conditions in this group.</span>
    ) : (
      <span className="mg-qb-hint">
        No conditions. Every document matches. Try <code>status</code> equals <code>"paid"</code>.
      </span>
    );
  }

  return (
    <div className="mg-qb-group" data-operator={scalarElement ? 'and' : group.operator}>
      {/* A scalar $elemMatch body is always AND, so it has no operator pill. */}
      {!scalarElement && (
        <div className="mg-qb-group-head">
          <SegmentedControl
            size="xs"
            radius="xl"
            aria-label="Group operator"
            color={GROUP_COLORS[group.operator]}
            data={GROUP_OPERATORS.map((operator) => ({
              value: operator,
              label: GROUP_LABELS[operator],
            }))}
            value={group.operator}
            onChange={(value) => onChange({ ...group, operator: value as GroupOperator })}
          />
          {nested && (
            <ActionIcon
              variant="subtle"
              color="red"
              size="input-xs"
              aria-label="Delete group"
              onClick={onDelete}
            >
              <IconTrash size={14} />
            </ActionIcon>
          )}
        </div>
      )}
      <div className="mg-qb-group-items">
        {group.items.map((item, index) => (
          <div className="mg-qb-item mg-qb-row" key={keyAt(index)}>
            {renderItem(item, index)}
          </div>
        ))}
      </div>
      <div className="mg-qb-group-foot">
        <Button
          size="xs"
          variant="default"
          leftSection={<IconPlus size={14} />}
          disabled={nextCondition === undefined}
          onClick={() => {
            if (nextCondition !== undefined) {
              add(nextCondition);
            }
          }}
        >
          Add condition
        </Button>
        {!scalarElement && (
          <Button
            size="xs"
            variant="default"
            leftSection={<IconFolderPlus size={14} />}
            onClick={() => add({ kind: 'group', operator: 'and', items: [] })}
          >
            Add group
          </Button>
        )}
        {hint}
      </div>
    </div>
  );
}
