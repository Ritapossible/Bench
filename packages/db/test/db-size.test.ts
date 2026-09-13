import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, PgCatalogRepository, runMigrations } from '../src/index.js';

/**
 * The number nobody was watching.
 *
 * Two databases have filled under this worker, and each time the first sign
 * was a failure rather than a warning: every insert returning "could not
 * extend file", the prober unable to record a probe, and the registry page
 * reporting zero verified-live agents because liveness could not be refreshed.
 * Bench measures everything about the agents it indexes; this is the one
 * measurement it takes of itself.
 */
const URL = process.env['TEST_DATABASE_URL'];
const describeDb = URL === undefined || URL === '' ? describe.skip : describe;

describeDb('sizeBytes', () => {
  const db = createDb(URL ?? '', { isolate: true });
  const catalog = new PgCatalogRepository(db);

  beforeAll(async () => {
    await runMigrations(URL ?? '');
  });
  afterAll(async () => {
    await db.$client.end();
  });

  it('reports a real, positive size', async () => {
    const bytes = await catalog.sizeBytes();
    expect(bytes).toBeGreaterThan(0);
    // A migrated but near-empty Bench database is megabytes, not gigabytes.
    // Both bounds are loose on purpose: this asserts the query returns the
    // database's size rather than a row count or a zero.
    expect(bytes).toBeGreaterThan(100_000);
    expect(bytes).toBeLessThan(5_000_000_000);
  });

  it('returns a number, not a bigint string', async () => {
    // pg returns int8 as a string by default, and a string compared against a
    // byte ceiling would compare lexically - "9" > "512000000" - so the guard
    // would trip at nine bytes or never.
    expect(typeof (await catalog.sizeBytes())).toBe('number');
  });
});
