import { z } from 'zod';

/**
 * The language of an editor tab. `mongosh` runs as typed. `sql` translates the text to mongosh
 * first and then runs the translation through the same path.
 */
export const EditorLanguageSchema = z.enum(['mongosh', 'sql']);

export type EditorLanguage = z.infer<typeof EditorLanguageSchema>;
