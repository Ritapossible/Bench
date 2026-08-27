/**
 * Deploy-time database step, run after a successful compile.
 *
 * Vercel builds the web app and nothing else - there is no worker on Vercel to
 * bring the schema forward - so a deploy that ships code expecting tables that
 * do not exist produces a site that builds cleanly and 500s on every page. This
 * closes that gap, and it deliberately *fails the build* when it cannot: a
 * broken deploy is better than a green one serving errors.
 *
 * That is not a contradiction of the page-rendering decision made earlier.
 * Prerendering coupled the build to *reading* data, where a blip failed a
 * deploy and bought nothing. This couples it to the schema being correct, which
 * is a thing the deploy genuinely must not ship ahead of.
 *
 * Three outcomes, all of them loud:
 *
 *   no database   -> skip, and say the deployment will serve fixtures
 *   empty catalog -> migrate, then seed, because a deployment with a database
 *                    and no agents is worse than one with fixtures: the pages
 *                    render, they are simply empty, and nothing says why
 *   has agents    -> migrate only. Never reseed - once the indexer is pointed
 *                    at a real registry, overwriting its work on every deploy
 *                    would be the single most destructive thing this could do.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.env['BENCH_SKIP_BUILD_MIGRATIONS'] === '1') {
  console.log('[bench:deploy] BENCH_SKIP_BUILD_MIGRATIONS=1, skipping');
  process.exit(0);
}

const { createDb, migrationUrl, runMigrations, schema } = await import('@bench/db');

const url = migrationUrl();
if (url === undefined) {
  console.log(
    '[bench:deploy] no DATABASE_URL - this deployment will serve FIXTURES. ' +
      'Add the Neon integration and redeploy to serve a real catalog.',
  );
  process.exit(0);
}

// Host only. A build log is not a secret store, and the connection string
// carries the password.
const host = (() => {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown host';
  }
})();

const env = process.env['VERCEL_ENV'] ?? 'local';
console.log(`[bench:deploy] ${env}: migrating ${host}`);
await runMigrations(url, resolve(root, 'packages/db/migrations'));
console.log('[bench:deploy] migrations applied');

// Seed only into an empty catalog.
const db = createDb(url);
const rows = await db.select({ id: schema.agents.id }).from(schema.agents).limit(1);
await db.$client.end();

if (rows.length > 0) {
  console.log('[bench:deploy] catalog already has agents, leaving it alone');
  process.exit(0);
}

console.log('[bench:deploy] catalog is empty, seeding');
// --no-install so a missing tsx is an immediate, legible failure rather than a
// silent network fetch on a build machine.
const seed = spawnSync('npx', ['--no-install', 'tsx', resolve(root, 'scripts/seed-catalog.ts')], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
if (seed.status !== 0) {
  console.error(
    '[bench:deploy] seeding failed. The schema is up to date but the catalog is empty, ' +
      'so pages will render with no agents. Run `npm run db:seed` against this database.',
  );
  process.exit(1);
}
console.log('[bench:deploy] catalog seeded');
