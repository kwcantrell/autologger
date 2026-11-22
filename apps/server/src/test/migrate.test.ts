import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { pendingMigrations } from '../db/migrate.ts';
import { setupDb } from './harness.ts';

beforeAll(setupDb);

const journal = JSON.parse(
  readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
) as { entries: { tag: string; when: number }[] };

describe('pendingMigrations', () => {
  it('is empty once the API has migrated, and lists journal entries the database lacks', async () => {
    expect(await pendingMigrations()).toEqual([]);
    const next = { tag: '9999_not_applied', when: journal.entries.at(-1)!.when + 1 };
    expect(await pendingMigrations({ entries: [...journal.entries, next] })).toEqual([next.tag]);
  });
});
