import type { CollectionInfo } from '@mongo-gui/core';
import { IconChartLine, IconEye, IconTable } from '@tabler/icons-react';

export interface CollectionIconProps {
  readonly type: CollectionInfo['type'];
}

/** Icon per collection type: a table for collections, an eye for views, a line for timeseries. */
export function CollectionIcon({ type }: CollectionIconProps) {
  switch (type) {
    case 'view':
      return <IconEye size={14} aria-label="View" />;
    case 'timeseries':
      return <IconChartLine size={14} aria-label="Timeseries" />;
    case 'collection':
      return <IconTable size={14} aria-label="Collection" />;
  }
}
