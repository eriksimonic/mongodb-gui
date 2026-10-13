import {
  IconBrandDocker,
  IconChartLine,
  IconChevronDown,
  IconChevronRight,
  IconDatabase,
  IconFiles,
  IconFolder,
  IconGauge,
  IconListDetails,
  IconServer,
  IconTopologyRing3,
} from '@tabler/icons-react';
import type { MouseEvent } from 'react';
import { CollectionIcon } from './CollectionIcon';
import { ConnectionStatusIcon } from './ConnectionStatusIcon';
import { DockerContainerMeta } from './DockerContainerMeta';
import { connectionTreeMeta } from './connection-status-label';
import type { ConnectionStatus, ReplicaSetMember } from '@mongo-gui/core';
import { memberStateTone, type TreeRow as TreeRowModel } from './tree-model';
import './tree.css';

const INDENT_PX = 16;
const LABEL_OFFSET_PX = 42;

export interface TreeRowProps {
  readonly row: TreeRowModel;
  readonly focused: boolean;
  readonly selected: boolean;
  readonly setRef: (key: string, element: HTMLDivElement | null) => void;
  readonly onFocusRow: (key: string) => void;
  readonly onToggle: () => void;
  readonly onSelect: () => void;
  readonly onDoubleClick: () => void;
  readonly onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
}

/** One focusable tree row. Roving tabindex: only the focused row sits in the tab order. */
export function TreeRow({
  row,
  focused,
  selected,
  setRef,
  onFocusRow,
  onToggle,
  onSelect,
  onDoubleClick,
  onContextMenu,
}: TreeRowProps) {
  return (
    <div
      role="treeitem"
      className="mg-tree-item"
      data-key={row.key}
      title={row.note}
      aria-level={row.depth + 1}
      aria-expanded={row.expandable ? row.expanded : undefined}
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      ref={(element) => setRef(row.key, element)}
      onFocus={() => onFocusRow(row.key)}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      style={{
        paddingLeft: row.depth * INDENT_PX + 4,
        boxShadow: row.color === undefined ? undefined : `inset 3px 0 0 ${row.color}`,
      }}
    >
      <span
        className="mg-tree-chevron"
        aria-hidden="true"
        onClick={(event) => {
          event.stopPropagation();
          if (row.expandable) {
            onToggle();
          }
        }}
      >
        {row.expandable ? (
          row.expanded ? (
            <IconChevronDown size={12} />
          ) : (
            <IconChevronRight size={12} />
          )
        ) : null}
      </span>
      <span className="mg-tree-icon" aria-hidden="true">
        <RowIcon row={row} />
      </span>
      <span className="mg-tree-label">{row.label}</span>
      {row.container === undefined ? null : <DockerContainerMeta container={row.container} />}
      {row.kind === 'connection' && row.status !== undefined ? (
        <ConnectionMeta status={row.status} />
      ) : null}
      {row.member === undefined ? null : <MemberMeta member={row.member} />}
    </div>
  );
}

/** The right side of a member row: its state, with a dot coloured by the state. */
function MemberMeta({ member }: { readonly member: ReplicaSetMember }) {
  return (
    <span className="mg-tree-meta" aria-hidden="true">
      <span className="mg-tree-image">{member.self ? `${member.state} · this` : member.state}</span>
      <span className="mg-tree-state" data-member-state={memberStateTone(member)} />
    </span>
  );
}

/** The right side of a connection row: the set name and whether the connection is direct. */
function ConnectionMeta({ status }: { readonly status: ConnectionStatus }) {
  const text = connectionTreeMeta(status);
  if (text === undefined) {
    return null;
  }
  // Decorative, as the container meta is: the status icon's tooltip carries the same words, and
  // the row name stays the connection name.
  return (
    <span className="mg-tree-meta" aria-hidden="true">
      <span className="mg-tree-image">{text}</span>
    </span>
  );
}

function RowIcon({ row }: { readonly row: TreeRowModel }) {
  if (row.kind === 'connection' && row.status !== undefined) {
    return <ConnectionStatusIcon status={row.status} />;
  }
  if (row.kind === 'collection' && row.collectionType !== undefined) {
    return <CollectionIcon type={row.collectionType} />;
  }
  if (row.kind === 'profiler') {
    return <IconGauge size={14} aria-hidden="true" />;
  }
  if (row.kind === 'gridfs') {
    return <IconFiles size={14} aria-hidden="true" />;
  }
  if (row.kind === 'gridfs-bucket') {
    return <IconFolder size={14} aria-hidden="true" />;
  }
  if (row.kind === 'docker' || row.kind === 'container') {
    return <IconBrandDocker size={14} />;
  }
  if (row.kind === 'monitor') {
    return <IconChartLine size={14} />;
  }
  if (row.kind === 'replica-set') {
    return <IconTopologyRing3 size={14} />;
  }
  if (row.kind === 'member') {
    return <IconServer size={14} />;
  }
  if (row.kind === 'operations') {
    return <IconListDetails size={14} />;
  }
  return <IconDatabase size={14} />;
}

export interface TreeMessageProps {
  readonly row: TreeRowModel;
}

/** A status line under a node: loading, not connected, or an error. Not focusable. */
export function TreeMessage({ row }: TreeMessageProps) {
  return (
    <div
      role="none"
      className="mg-tree-message"
      data-tone={row.tone}
      style={{ paddingLeft: row.depth * INDENT_PX + LABEL_OFFSET_PX }}
    >
      {row.label}
    </div>
  );
}
