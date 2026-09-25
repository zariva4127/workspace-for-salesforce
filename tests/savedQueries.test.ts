import { describe, expect, it } from 'vitest';
import { duplicateQuery, renameQuery, saveQuery } from '../src/shared/workspace/savedQueries';
describe('saved queries', () => {
  it('saves, renames, and duplicates queries', () => {
    const one = saveQuery([], { name: 'Accounts', query: 'SELECT Id FROM Account', tooling: false }, 1, 'a');
    const renamed = renameQuery(one, 'a', 'Open accounts', 2);
    const duplicated = duplicateQuery(renamed, 'a', 3, 'b');
    expect(duplicated.map((q) => q.name)).toEqual(['Open accounts copy', 'Open accounts']);
  });
});
