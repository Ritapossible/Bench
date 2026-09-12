import { describe, expect, it } from 'vitest';
import { indexerProfileFor } from '../src/indexer.js';

/**
 * The numbers matter for a specific reason, so the test states it: at testnet's
 * batch size a full mainnet pass takes longer than the re-sweep timer, which
 * puts the indexer in a permanent rewrite of every row in the registry.
 */
const MAINNET_TOKENS = 343_245;
const TICK_MS = 300_000;

describe('indexerProfileFor', () => {
  it('finishes a full mainnet pass in hours, not days', () => {
    const { batchSize } = indexerProfileFor('bsc-mainnet');
    const hours = ((MAINNET_TOKENS / batchSize) * TICK_MS) / 3_600_000;
    expect(hours).toBeLessThan(24);
  });

  it('leaves a wide margin between finishing a pass and starting the next', () => {
    const { batchSize, resweepAfterMs } = indexerProfileFor('bsc-mainnet');
    const passMs = (MAINNET_TOKENS / batchSize) * TICK_MS;
    // The bug this encodes: a re-sweep that rearms before or just after a pass
    // ends means the indexer never stops rewriting the whole registry.
    expect(resweepAfterMs).toBeGreaterThan(passMs * 10);
  });

  it('leaves testnet on the settings tuned for it', () => {
    expect(indexerProfileFor('bsc-testnet')).toEqual({
      batchSize: 500,
      resweepAfterMs: 6 * 60 * 60 * 1000,
    });
  });

  it('treats an unknown chain as small, which is the safe way to be wrong', () => {
    expect(indexerProfileFor('some-new-chain').batchSize).toBe(500);
  });
});
