import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * Apply pending migrations.
 *
 * Deliberately built on `drizzle-orm`'s migrator rather than `drizzle-kit push`.
 * `push` diffs the schema against whatever the database currently looks like and
 * applies the difference - convenient in development, and wrong for a deploy in
 * two ways: the SQL it will run is not visible until it runs, and a diff that
 * decides a column changed type will happily rewrite a populated table. The
 * migration files under `migrations/` are checked in, reviewable, applied in
 * order and recorded, so a deploy does the same thing every time.
 *
 * Runs against `DATABASE_URL`, takes a Postgres advisory lock for the duration,
 * and is safe to call from every instance on boot: concurrent callers queue on
 * the lock and the losers find nothing left to apply.
 */
/**
 * The connection string migrations should use.
 *
 * Neon's Vercel integration provides two: `DATABASE_URL` goes through PgBouncer
 * and `DATABASE_URL_UNPOOLED` goes straight to the compute. Migrations need the
 * direct one, and not as a preference - the migrator takes an advisory lock so
 * that concurrent instances queue rather than race, and PgBouncer in
 * transaction mode hands each statement to whichever backend is free, so the
 * lock would be taken on one connection and released on another. The migration
 * then runs unprotected, which is the exact case the lock exists for.
 *
 * Falls back to `DATABASE_URL` for a plain Postgres with no pooler in front,
 * where the two are the same connection anyway.
 */
export function migrationUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct =
    env['DATABASE_URL_UNPOOLED'] ?? env['POSTGRES_URL_NON_POOLING'] ?? env['DIRECT_DATABASE_URL'];
  const url = direct ?? env['DATABASE_URL'];
  return url === undefined || url.trim() === '' ? undefined : url;
}

export async function runMigrations(
  connectionString: string,
  migrationsFolder?: string,
): Promise<void> {
  const folder =
    migrationsFolder ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}

// `npm run migrate -w @bench/db`
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const url = migrationUrl();
  if (url === undefined) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  runMigrations(url).then(
    () => {
      console.log('migrations applied');
      process.exit(0);
    },
    (err: unknown) => {
      console.error('migration failed:', err);
      process.exit(1);
    },
  );
}
