export interface SeverityStyle {
  readonly label: string;
  readonly color: string;
  /** Whether the whole row is tinted, so a problem stands out while scrolling. */
  readonly tint: boolean;
}

/** The colour of a mongod log severity: F and E red, W orange, I and D1 to D5 grey, D1 to D5 grey. */
export function severityStyle(severity: string | undefined): SeverityStyle {
  switch (severity?.charAt(0)) {
    case 'F':
      return { label: 'Fatal', color: 'red', tint: true };
    case 'E':
      return { label: 'Error', color: 'red', tint: true };
    case 'W':
      return { label: 'Warning', color: 'orange', tint: true };
    case 'I':
      return { label: 'Info', color: 'gray', tint: false };
    case 'D':
      return { label: 'Debug', color: 'gray', tint: false };
    default:
      return { label: severity ?? '', color: 'gray', tint: false };
  }
}
