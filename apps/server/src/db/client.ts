import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.ts';
import * as schema from './schema.ts';

export const sqlClient = postgres(env.databaseUrl, {
  max: 10,
  onnotice: () => {},
});

export const db = drizzle(sqlClient, { schema, casing: 'snake_case' });

export type Db = typeof db;
/** A transaction handle; ops always run inside one. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export { schema };
