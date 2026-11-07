import { Switch } from '@mantine/core';
import type { ReactNode } from 'react';
import type { CardTone, IconComponent } from './card-kinds';
import './builder.css';

export interface BuilderCardProps {
  readonly title: string;
  /** True for a stage name such as `$match`, which is set in the code font. */
  readonly code?: boolean;
  readonly icon: IconComponent;
  readonly tone: CardTone;
  /** A short dimmed line after the title: "2 conditions", "All fields". */
  readonly summary?: string | undefined;
  /** Extra header items before the actions, such as the "Not in the query yet" note. */
  readonly note?: ReactNode;
  /** Buttons at the right edge, before the switch. */
  readonly actions?: ReactNode;
  readonly enabled: boolean;
  readonly toggleLabel: string;
  readonly onToggle: (enabled: boolean) => void;
  /** The accessible name of the region. Defaults to the title. */
  readonly ariaLabel?: string;
  readonly children: ReactNode;
}

/**
 * The shell of a find panel and a stage card: a header with the kind icon, the title, a summary
 * and the enable switch, then the body. A disabled card cannot be edited and keeps its rows.
 */
export function BuilderCard({
  title,
  code = false,
  icon: Icon,
  tone,
  summary,
  note,
  actions,
  enabled,
  toggleLabel,
  onToggle,
  ariaLabel,
  children,
}: BuilderCardProps) {
  return (
    <section
      className="mg-qb-card"
      aria-label={ariaLabel ?? title}
      data-tone={tone}
      data-enabled={enabled}
    >
      <div className="mg-qb-card-head">
        <span className="mg-qb-card-icon">
          <Icon size={16} stroke={1.75} />
        </span>
        <span className="mg-qb-card-title" data-code={code}>
          {title}
        </span>
        {/* Always present: it is the spacer that keeps the actions at the right edge. */}
        <span className="mg-qb-card-summary">{summary}</span>
        {note}
        {actions !== undefined && <span className="mg-qb-card-actions">{actions}</span>}
        <Switch
          size="xs"
          aria-label={toggleLabel}
          checked={enabled}
          onChange={(event) => onToggle(event.currentTarget.checked)}
        />
      </div>
      <div className="mg-qb-card-body" inert={!enabled}>
        {children}
      </div>
    </section>
  );
}
