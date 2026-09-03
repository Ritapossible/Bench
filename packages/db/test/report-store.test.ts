import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, PgReportStore, runMigrations, schema } from '../src/index.js';

const URL = process.env['TEST_DATABASE_URL'];
const describeDb = URL === undefined || URL === '' ? describe.skip : describe;

const ADDR = '0x7a16ff8270133f063aab6c9977183d9e72835428';

describeDb('PgReportStore', () => {
  const db = createDb(URL ?? '', { isolate: true });
  const store = new PgReportStore(db);

  beforeAll(async () => {
    await runMigrations(URL ?? '');
  });

  beforeEach(async () => {
    await db.delete(schema.reportRequests);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('records a request and hands it to exactly one claimer', async () => {
    // Two workers racing must not both fork a chain for the same position and
    // record two sets of runs under one window.
    await store.request('bsc-testnet', ADDR);

    const [a, b] = await Promise.all([
      store.claimNext('bsc-testnet'),
      store.claimNext('bsc-testnet'),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.address).toBe(ADDR);
    expect(winners[0]?.status).toBe('running');
  });

  it('normalises the address, so two spellings are one request', async () => {
    await store.request('bsc-testnet', ADDR.toUpperCase().replace('0X', '0x'));
    expect((await store.get('bsc-testnet', ADDR))?.address).toBe(ADDR);
  });

  it('does not re-queue a request that is already running', async () => {
    // A reader refreshing the page must not stack forks behind themselves.
    await store.request('bsc-testnet', ADDR);
    await store.claimNext('bsc-testnet');

    await store.request('bsc-testnet', ADDR);

    expect((await store.get('bsc-testnet', ADDR))?.status).toBe('running');
    expect(await store.claimNext('bsc-testnet')).toBeNull();
  });

  it('re-opens a finished report when asked again', async () => {
    // The question is what agents would do with the position now, so a repeat
    // ask is a new measurement rather than a cached one.
    await store.request('bsc-testnet', ADDR);
    await store.claimNext('bsc-testnet');
    await store.finish('bsc-testnet', ADDR, { ok: true, windowId: 'w1', agentsRun: 4 });
    expect((await store.get('bsc-testnet', ADDR))?.status).toBe('complete');

    await store.request('bsc-testnet', ADDR);
    expect((await store.get('bsc-testnet', ADDR))?.status).toBe('pending');
  });

  it('keeps the window and the count a completed report was built from', async () => {
    await store.request('bsc-testnet', ADDR);
    await store.claimNext('bsc-testnet');
    await store.finish('bsc-testnet', ADDR, { ok: true, windowId: 'addr-x-42', agentsRun: 7 });

    const got = await store.get('bsc-testnet', ADDR);
    expect(got?.windowId).toBe('addr-x-42');
    expect(got?.agentsRun).toBe(7);
    expect(got?.completedAt).not.toBeNull();
  });

  it('redacts a failure reason, which is rendered on a public page', async () => {
    await store.request('bsc-testnet', ADDR);
    await store.claimNext('bsc-testnet');
    await store.finish('bsc-testnet', ADDR, {
      ok: false,
      reason: 'fork failed: URL: https://cold.bsc.quiknode.pro/SECRETKEY00000000000000/',
    });

    const got = await store.get('bsc-testnet', ADDR);
    expect(got?.failureReason).not.toContain('SECRETKEY00000000000000');
    expect(got?.failureReason).toContain('[redacted]');
  });

  it('releases a request a crashed worker left claimed', async () => {
    // Without this the reader waits forever on "working on it" - the failure
    // mode that is indistinguishable from success until somebody checks.
    await store.request('bsc-testnet', ADDR);
    await store.claimNext('bsc-testnet');
    expect(await store.claimNext('bsc-testnet')).toBeNull();

    expect(await store.releaseStale('bsc-testnet', -1)).toBe(1);
    expect((await store.claimNext('bsc-testnet'))?.address).toBe(ADDR);
  });

  it('leaves a healthy in-flight request alone', async () => {
    await store.request('bsc-testnet', ADDR);
    await store.claimNext('bsc-testnet');
    expect(await store.releaseStale('bsc-testnet', 10 * 60_000)).toBe(0);
  });
});
