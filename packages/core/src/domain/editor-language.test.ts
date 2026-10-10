import { describe, expect, it } from 'vitest';
import { EditorLanguageSchema } from './editor-language';

describe('EditorLanguageSchema', () => {
  it('accepts mongosh', () => {
    expect(EditorLanguageSchema.safeParse('mongosh').success).toBe(true);
  });

  it('accepts sql', () => {
    expect(EditorLanguageSchema.safeParse('sql').success).toBe(true);
  });

  it('lists exactly the two languages', () => {
    expect(EditorLanguageSchema.options).toEqual(['mongosh', 'sql']);
  });

  it('rejects other names, including the Monaco id of the T-SQL grammar', () => {
    for (const value of ['tsql', 'SQL', 'Mongosh', 'javascript', '', undefined, 1]) {
      expect(EditorLanguageSchema.safeParse(value).success).toBe(false);
    }
  });
});
