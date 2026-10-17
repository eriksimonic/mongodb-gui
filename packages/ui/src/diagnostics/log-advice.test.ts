import { describe, expect, it } from 'vitest';
import { warningAdvice, warningTitle } from './log-advice';

describe('warningAdvice', () => {
  it('names the fix for a known warning', () => {
    expect(warningAdvice('vm.max_map_count is too low')).toMatch(/sysctl/);
  });

  it('says nothing about an unknown warning', () => {
    expect(warningAdvice('Something else')).toBeUndefined();
  });
});

describe('warningTitle', () => {
  it('drops the suggestion of a known warning and straightens its quotes', () => {
    expect(
      warningTitle("/sys/kernel/mm/transparent_hugepage/enabled is 'always'. We suggest 'never'"),
    ).toBe('/sys/kernel/mm/transparent_hugepage/enabled is "always"');
  });

  it('keeps the whole text of an unknown warning', () => {
    expect(warningTitle('One thing. Another thing')).toBe('One thing. Another thing');
  });
});
