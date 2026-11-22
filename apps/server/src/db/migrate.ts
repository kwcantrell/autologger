import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sqlClient } from './client.ts';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

type Journal = { entries: { tag: string; when: number }[] };

const readJournal = (): Journal =>
  JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8')) as Journal;

/**
 * Tags of the migrations in the journal that the database has not applied yet. Uses drizzle's own
 * rule: a migration is applied when the newest `drizzle.__drizzle_migrations.created_at` is at
 * least its journal `when`.
 */
export async function pendingMigrations(journal: Journal = readJournal()): Promise<string[]> {
  const [table] = await db.execute<{ name: string | null }>(
    sql`select to_regclass('drizzle.__drizzle_migrations')::text as name`,
  );
  let last = -1;
  if (table?.name) {
    const [row] = await db.execute<{ last: string | null }>(
      sql`select max(created_at) as last from drizzle.__drizzle_migrations`,
    );
    last = Number(row?.last ?? -1);
  }
  return journal.entries.filter((e) => e.when > last).map((e) => e.tag);
}

/**
 * Block until the API has applied every migration this build ships (only the API runs them; the
 * worker can start first, e.g. when `node --watch` restarts both after a merge). Drizzle's
 * migrator takes no lock, so a second process must not run it concurrently.
 */
export async function waitForMigrations(retryMs = 2000): Promise<void> {
  let said = '';
  for (;;) {
    const pending = await pendingMigrations().catch((e: unknown) => [
      `(database unreachable: ${e instanceof Error ? e.message : String(e)})`,
    ]);
    if (pending.length === 0) return;
    const line = `waiting for migrations (the API applies them): ${pending.at(-1)}${pending.length > 1 ? ` and ${pending.length - 1} more` : ''}`;
    if (line !== said) console.log(line);
    said = line;
    await sleep(retryMs);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations();
  console.log('migrations applied');
  await sqlClient.end();
}
