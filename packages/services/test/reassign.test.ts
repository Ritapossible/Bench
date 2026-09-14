import { describe, expect, it } from 'vitest';
import { InMemoryHireStore } from '../src/hire.js';
import type { Address, HireRecord } from '@bench/core';

const OWNER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const OWNER_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as Address;
const OTHER = '0xcccccccccccccccccccccccccccccccccccccccc' as Address;

const record = (id: string, owner: Address): HireRecord =>
  ({
    id,
    idempotencyKey: `k-${id}`,
    state: 'active',
    owner,
    agent: { chain: 'bsc-mainnet', tokenId: 1n },
    mandate: {},
    mandateSignature: null,
    mandateState: { spent: 0n, actions: 0, revokedAt: null },
    envelope: {},
    envelopePolicy: undefined,
    escrowJobId: null,
    paymentTxHash: null,
    trace: [],
    createdAt: new Date('2026-09-01T00:00:00Z'),
  }) as unknown as HireRecord;

/**
 * Connecting a wallet must not look like losing everything.
 *
 * A visitor hires under a per-browser session id, then connects a wallet. The
 * hires are still there, under an id the session has just stopped using - and
 * without this they simply vanish from `/hires`, which is a worse first
 * impression than never offering the wallet at all.
 */
describe('reassign', () => {
  it('moves every hire from one owner to the other, and nobody else’s', async () => {
    const store = new InMemoryHireStore();
    await store.claim(record('h1', OWNER_A));
    await store.claim(record('h2', OWNER_A));
    await store.claim(record('h3', OTHER));

    expect(await store.reassign(OWNER_A, OWNER_B)).toBe(2);
    expect((await store.listByOwner(OWNER_B)).map((h) => h.id).sort()).toEqual(['h1', 'h2']);
    expect(await store.listByOwner(OWNER_A)).toEqual([]);
    // The bystander is untouched. A transfer that swept up an unrelated owner
    // would hand one visitor another's mandates and full decision traces.
    expect((await store.listByOwner(OTHER)).map((h) => h.id)).toEqual(['h3']);
  });

  it('is a no-op when the two are the same address in different case', async () => {
    // Reconnecting the same wallet twice, or connecting one already bound.
    // Checksummed and lower-case spellings are one account, and treating them
    // as two would move hires onto an identity nobody looks under.
    const store = new InMemoryHireStore();
    await store.claim(record('h1', OWNER_B));
    expect(await store.reassign(OWNER_B.toLowerCase() as Address, OWNER_B)).toBe(0);
    expect((await store.listByOwner(OWNER_B)).map((h) => h.id)).toEqual(['h1']);
  });

  it('reports zero rather than failing when there is nothing to move', async () => {
    const store = new InMemoryHireStore();
    expect(await store.reassign(OWNER_A, OWNER_B)).toBe(0);
  });
});
