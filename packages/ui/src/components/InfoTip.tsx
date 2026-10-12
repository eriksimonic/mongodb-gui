import { Tooltip } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';

/** A form label followed by a focusable info icon that shows `tip` on hover or focus. */
export function TipLabel({ label, tip }: { readonly label: string; readonly tip: string }) {
  return (
    <>
      {label}
      <Tooltip label={tip} multiline maw={280} events={{ hover: true, focus: true, touch: true }}>
        <span
          tabIndex={0}
          role="img"
          aria-label={tip}
          style={{ display: 'inline-flex', marginLeft: 4, verticalAlign: 'middle', cursor: 'help' }}
          onClick={(event) => {
            // Inside a label, a click would toggle the control.
            event.preventDefault();
          }}
        >
          <IconInfoCircle size={14} aria-hidden />
        </span>
      </Tooltip>
    </>
  );
}
