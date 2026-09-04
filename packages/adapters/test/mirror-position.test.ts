import { describe, expect, it } from 'vitest';
import {
  MIN_AUDITIONABLE_USD,
  mirrorPosition,
  reportWindowFor,
  SEEDABLE_TOKENS,
} from '../src/shadow/windows.js';

const USDT = '0x55d398326f99059ff775485246999027b3197955';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const UNKNOWN = `0x${'99'.repeat(20)}`;
const ADDR = '0x7a16ff8270133f063aab6c9977183d9e72835428';

const holding = (token: string, symbol: string, amount: bigint, valuedUsd: number | null) => ({
  token,
  symbol,
  amount,
  valuedUsd,
});

describe('mirrorPosition', () => {
  it('mirrors the largest holding whose storage slot is known', () => {
    // This is what makes /report a measurement rather than a projection: the
    // fork carries the reader's own balances, so the delta is about their
    // position and not about a stand-in.
    const m = mirrorPosition(
      {
        address: ADDR,
        nativeWei: 2n * 10n ** 18n,
        holdings: [
          holding(WBNB, 'WBNB', 1n * 10n ** 18n, 600),
          holding(USDT, 'USDT', 5_000n * 10n ** 18n, 5_000),
        ],
      },
      'bsc-mainnet',
    );

    expect(m?.template.params['token']).toBe(USDT);
    expect(m?.template.params['tokenAmount']).toBe(5_000n * 10n ** 18n);
    expect(m?.template.params['nativeWei']).toBe(2n * 10n ** 18n);
    expect(m?.mirroredSymbols).toEqual(['USDT', 'BNB']);
    expect(m?.unmirroredSymbols).toEqual(['WBNB']);
  });

  it('uses the slot the token actually stores balances at', () => {
    // WBNB keeps balances at slot 3, not 1. A default would write into an
    // unrelated variable and hand the agent a position that is not the
    // reader's - which would look like a working report and be a fiction.
    const m = mirrorPosition(
      { address: ADDR, nativeWei: 0n, holdings: [holding(WBNB, 'WBNB', 10n ** 18n, 600)] },
      'bsc-mainnet',
    );

    expect(m?.template.params['balanceSlot']).toBe(3n);
    expect(SEEDABLE_TOKENS[USDT]?.balanceSlot).toBe(1n);
  });

  it('prices the token from what the holding was actually worth', () => {
    // A default of $1 would value a reader's CAKE at a stablecoin price and
    // report a delta denominated in a position they do not hold.
    const CAKE = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82';
    const m = mirrorPosition(
      { address: ADDR, nativeWei: 0n, holdings: [holding(CAKE, 'CAKE', 100n * 10n ** 18n, 250)] },
      'bsc-mainnet',
    );

    expect(m?.template.params['tokenPriceUsd']).toBeCloseTo(2.5, 6);
  });

  it('mirrors a position that is only native BNB', () => {
    // The most ordinary thing an address on this chain holds. Requiring an
    // ERC-20 leg reported it as unmirrorable, and the seeder had always
    // handled an absent token - it writes the balance and skips the storage
    // write - so there was never anything to refuse.
    const m = mirrorPosition(
      { address: ADDR, nativeWei: 2n * 10n ** 18n, holdings: [] },
      'bsc-mainnet',
    );

    expect(m).not.toBeNull();
    expect(m?.template.params['nativeWei']).toBe(2n * 10n ** 18n);
    expect(m?.template.params['token']).toBeUndefined();
    expect(m?.mirroredSymbols).toEqual(['BNB']);
    expect(m?.template.capital.symbol).toBe('BNB');
  });

  it('refuses a position too small for an agent to act on', () => {
    // The seeded balance is also the agent's gas budget, so below a few
    // dollars every agent fails for a reason that is about the position rather
    // than the agent - and this project exists not to publish that as a
    // finding. A real address holding $0.59 of BNB is what surfaced it.
    const dust = mirrorPosition(
      { address: ADDR, nativeWei: 822_759_217_783_039n, holdings: [] },
      'bsc-mainnet',
    );
    expect(dust).toBeNull();

    // Just over the line is fine, so the rule is a floor and not a filter on
    // anything but size.
    const enough = Math.ceil((MIN_AUDITIONABLE_USD / 687.46) * 1e18) + 1e15;
    expect(
      mirrorPosition({ address: ADDR, nativeWei: BigInt(enough), holdings: [] }, 'bsc-mainnet'),
    ).not.toBeNull();
  });

  it('refuses a position it cannot seed rather than approximating one', () => {
    // Naming the limit is the point. An empty audition against a token whose
    // layout is unknown would score every agent at zero and read as a finding
    // about the agents.
    expect(
      mirrorPosition(
        { address: ADDR, nativeWei: 10n ** 15n, holdings: [holding(UNKNOWN, 'MYSTERY', 500n, 12)] },
        'bsc-mainnet',
      ),
    ).toBeNull();
  });

  it('refuses an address that holds nothing', () => {
    expect(
      mirrorPosition({ address: ADDR, nativeWei: 0n, holdings: [] }, 'bsc-mainnet'),
    ).toBeNull();
  });

  it('ignores a zero balance in a token it could otherwise seed', () => {
    expect(
      mirrorPosition(
        { address: ADDR, nativeWei: 10n ** 15n, holdings: [holding(USDT, 'USDT', 0n, 0)] },
        'bsc-mainnet',
      ),
    ).toBeNull();
  });

  it('keys the window by address and block, so runs are findable and distinct', () => {
    // Windows are inserted on-conflict-do-nothing, so a shared id across two
    // readers would file one reader's runs under the other's report.
    const a = reportWindowFor(ADDR, 100n);
    const b = reportWindowFor(`0x${'11'.repeat(20)}`, 100n);
    expect(a.id).not.toBe(b.id);
    expect(a.id).toContain(ADDR);
    expect(reportWindowFor(ADDR, 101n).id).not.toBe(a.id);
  });

  it('lowercases the address in the window id, so two spellings are one report', () => {
    expect(reportWindowFor(ADDR.toUpperCase().replace('0X', '0x'), 5n).id).toBe(
      reportWindowFor(ADDR, 5n).id,
    );
  });
});
