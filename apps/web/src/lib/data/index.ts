import { fixtureData } from './fixtures';
import { createPgData } from './postgres';
import type { BenchData } from './types';

/**
 * The swap point.
 *
 * Every page reads `data` and nothing else. Which backing it gets is decided
 * here, once, by whether a database is configured:
 *
 *   - `DATABASE_URL` set  → Postgres, served by the indexer, prober and shadow
 *     engine. This is what runs in production and what judges will see.
 *   - unset               → fixtures, so `npm run dev` works on a fresh clone
 *     with no database, and so the UI can be developed against a known shape.
 *
 * Read once at module load rather than per request: a process that started
 * without a database should not silently start using one halfway through, and
 * a connection pool per request would be worse than either.
 *
 * The fallback is deliberately loud in production. Serving fixtures to a judge
 * while looking exactly like the real thing is the single worst failure this
 * file could have, so it says so on boot rather than being discovered later.
 */

const url = process.env['DATABASE_URL'];
const usingPostgres = url !== undefined && url.trim() !== '';

if (!usingPostgres && process.env['NODE_ENV'] === 'production') {
  console.warn(
    '[bench] DATABASE_URL is not set - serving FIXTURES, not indexed data. ' +
      'Set DATABASE_URL to serve the real catalog.',
  );
}

export const data: BenchData = usingPostgres ? createPgData(url) : fixtureData;

/** True when the pages are backed by the real catalog. Surfaced in the UI. */
export const isLiveData = usingPostgres;

export type * from './types';
