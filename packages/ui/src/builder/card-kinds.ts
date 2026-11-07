import type { StageBody } from '@mongo-gui/core';
import {
  IconArrowBarToDown,
  IconArrowsSort,
  IconArrowsSplit2,
  IconCode,
  IconColumns3,
  IconFilter,
  IconGitMerge,
  IconHash,
  IconLayersIntersect,
  IconPlayerSkipForward,
} from '@tabler/icons-react';
import type { ComponentType } from 'react';

/** The colour of a card, set in `builder.css` by `data-tone`. One meaning has one colour. */
export type CardTone =
  'match' | 'project' | 'sort' | 'group' | 'lookup' | 'unwind' | 'count' | 'raw';

export type IconComponent = ComponentType<{ size?: number | string; stroke?: number | string }>;

/** The icon of each stage kind, and of the find panels that share a kind. */
export const STAGE_ICONS: Record<StageBody['stage'], IconComponent> = {
  $match: IconFilter,
  $project: IconColumns3,
  $sort: IconArrowsSort,
  $limit: IconArrowBarToDown,
  $skip: IconPlayerSkipForward,
  $count: IconHash,
  $unwind: IconArrowsSplit2,
  $group: IconLayersIntersect,
  $lookup: IconGitMerge,
  raw: IconCode,
};

/** The tone of each stage kind. */
export const STAGE_TONES: Record<StageBody['stage'], CardTone> = {
  $match: 'match',
  $project: 'project',
  $sort: 'sort',
  $limit: 'count',
  $skip: 'count',
  $count: 'count',
  $unwind: 'unwind',
  $group: 'group',
  $lookup: 'lookup',
  raw: 'raw',
};

/** "1 condition", "3 fields". */
export function countText(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
