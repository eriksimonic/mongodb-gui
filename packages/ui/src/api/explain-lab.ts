import labQueries from '../../../../dev/explain-lab/queries.js?raw';

/** The database dev/explain-lab/seed.js fills. */
export const LAB_DATABASE = 'explain_lab';

/** One statement of dev/explain-lab/queries.js and the fixture captured from it. */
export interface LabQuery {
  readonly name: string;
  readonly statement: string;
}

/** The cases of queries.js: the name on each `// case:` line and the statement under it. */
export const LAB_QUERIES: readonly LabQuery[] = labQueries
  .split(/^\/\/ case: /m)
  .slice(1)
  .map((block) => {
    const [name = '', ...lines] = block.split('\n');
    const isComment = (line: string) => line.trim().startsWith('//');
    return {
      name: name.trim(),
      statement: lines
        .filter((line) => !isComment(line))
        .join('\n')
        .trim(),
    };
  });
