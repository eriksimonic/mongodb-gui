import { describe, expect, it } from 'vitest';
import { severityStyle } from './log-severity';

describe('severityStyle', () => {
  it('colours by the first letter', () => {
    expect(severityStyle('E').color).toBe('red');
    expect(severityStyle('W')).toMatchObject({ color: 'orange', tint: true });
    expect(severityStyle('I').tint).toBe(false);
    expect(severityStyle('D3').color).toBe('gray');
  });
  it('keeps an unknown value as its own label', () => {
    expect(severityStyle(undefined).label).toBe('');
    expect(severityStyle('X').label).toBe('X');
  });
});
