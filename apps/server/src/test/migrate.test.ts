import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/client.ts';
import { pendingMigrations, runMigrations } from '../db/migrate.ts';
import { env } from '../env.ts';
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

describe('runMigrations', () => {
  it('serializes concurrent runs: both succeed on a fresh database, each migration applied once', async () => {
    const url = new URL(env.databaseUrl);
    const name = `${url.pathname.slice(1)}_fresh`;
    url.pathname = `/${name}`;
    await db.execute(sql.raw(`drop database if exists "${name}"`));
    await db.execute(sql.raw(`create database "${name}"`));
    try {
      await Promise.all([runMigrations(url.href), runMigrations(url.href)]);
      const fresh = postgres(url.href, { max: 1, onnotice: () => {} });
      const rows = await fresh`select count(*)::int as n from drizzle.__drizzle_migrations`;
      await fresh.end();
      expect(rows[0]!.n).toBe(journal.entries.length);
    } finally {
      await db.execute(sql.raw(`drop database if exists "${name}"`));
    }
  }, 60_000);
});
