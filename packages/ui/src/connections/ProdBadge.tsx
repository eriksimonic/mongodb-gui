const PROD_DESCRIPTION = 'Production connection';

/**
 * The red PROD mark on a production connection, in the tree and in the tab headers. The mark and
 * the hidden text are both left out of the accessible name, so the name stays the connection name.
 * The row or tab points at the hidden text with aria-describedby, so screen readers announce it.
 */
export function ProdBadge({ id }: { readonly id: string }) {
  return (
    <>
      <span
        aria-hidden="true"
        style={{
          flex: 'none',
          marginLeft: 6,
          padding: '0 4px',
          border: '1px solid currentColor',
          borderRadius: 3,
          color: 'var(--mg-danger)',
          fontSize: 'calc(var(--mg-font-scale, 1) * 10px)',
          fontWeight: 600,
          lineHeight: '14px',
        }}
      >
        PROD
      </span>
      <span id={id} hidden>
        {PROD_DESCRIPTION}
      </span>
    </>
  );
}
