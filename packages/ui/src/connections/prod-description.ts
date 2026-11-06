/** The id of the hidden text that a tree row or tab points at with aria-describedby. */
export function prodDescriptionId(key: string): string {
  return `prod-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}
