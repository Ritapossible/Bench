/**
 * Seed a Postgres catalog from the same definitions the fixtures use.
 *
 * Why this exists: the catalog is only as real as the registry the indexer
 * points at, and until the ERC-8004 registry address on BSC testnet is
 * confirmed there is nothing to index. Rather than let a deployment fall back
 * to fixtures - which look identical to real data in the UI and are therefore
 * the most dangerous thing to serve - this writes a known catalog into the
 * database, so what a deployment shows has been through the indexer's own
 * repository, the prober's own liveness maths, and the same verified-live
 * predicate as production.
 *
 * It reads `SEEDS` from the web app's fixtures rather than redefining them.
 * Two copies of "the demo catalog" that drift apart is exactly the bug that
 * makes a staging environment stop predicting production.
 *
 *   DATABASE_URL=... npm run db:seed
 *
 * Idempotent: agents upsert on (chain, tokenId), and probes are rewritten only
 * when the existing history is missing or has gone stale - so re-running before
 * a demo refreshes liveness, while re-running twice in a minute does not
 * inflate the probe count into a track record nobody measured.
 */
import { VERIFIED_LIVE, isVerifiedLive } from '@bench/core';
import { PgAuditionStore, PgCatalogRepository, createDb, runMigrations } from '@bench/db';
import { SEEDS, probes, record, score } from '../apps/web/src/lib/data/fixtures.js';

const CHAIN = 'bsc-testnet' as const;

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.trim() === '') {
    console.error('DATABASE_URL is not set. Start Postgres with `npm run db:up` first.');
    process.exit(1);
  }

  await runMigrations(url);
  const db = createDb(url);
  const catalog = new PgCatalogRepository(db);
  const audition = new PgAuditionStore(db);

  const upserted = await catalog.upsertAgents(SEEDS.map(record));
  console.log(`[seed] ${upserted} agents upserted`);

  let probeCount = 0;
  let scored = 0;
  for (const seed of SEEDS) {
    const existing = await catalog.liveness({ chain: CHAIN, tokenId: BigInt(seed.tokenId) });
    // Re-probe when the history is missing *or* stale. "Verified live" means
    // probed within six hours, so a seed that only ever writes probes once
    // produces a catalog that silently empties out overnight - which is exactly
    // what happened the first time this ran.
    const stale =
      existing.lastProbedAt === null ||
      Date.now() - existing.lastProbedAt.getTime() > VERIFIED_LIVE.maxProbeAgeMs;
    if (stale) {
      for (const p of probes(seed)) {
        await catalog.recordProbe(p);
        probeCount += 1;
      }
    }
    const s = score(seed);
    if (s !== null) {
      await audition.putScore(s);
      scored += 1;
    }
  }
  console.log(`[seed] ${probeCount} probes recorded, ${scored} scores written`);

  const stats = await catalog.stats(CHAIN);
  await audition.recordStats(stats);

  // Report the verified-live count the way the catalog page computes it, not
  // the way the seed intended it. If the two disagree, the seed is wrong about
  // its own data and it is better to find that out here than on the front page.
  let live = 0;
  for (const seed of SEEDS) {
    if (isVerifiedLive(await catalog.liveness({ chain: CHAIN, tokenId: BigInt(seed.tokenId) })))
      live += 1;
  }

  console.log(
    `[seed] registered=${stats.registered} cards=${stats.withResolvableCard} verified-live=${stats.verifiedLive}`,
  );
  console.log(`[seed] verified-live recomputed per agent: ${live}`);
  if (live !== stats.verifiedLive) {
    console.error('[seed] MISMATCH: the catalog stats query and isVerifiedLive disagree.');
    process.exitCode = 1;
  }

  await db.$client.end();
}

main().catch((err: unknown) => {
  console.error('[seed] failed', err);
  process.exit(1);
});
