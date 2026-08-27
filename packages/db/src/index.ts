import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export * as schema from './schema.js';
export { PgCatalogRepository } from './catalog-repository.js';
export { PgHireStore } from './hire-store.js';
export { runMigrations } from './migrate.js';
export { PgAuditionStore } from './audition-store.js';
export type Db = ReturnType<typeof createDb>;

export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return drizzle(pool, { schema });
}
