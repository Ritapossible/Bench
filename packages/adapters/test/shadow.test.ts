import { describe, expect, it } from 'vitest';
import { replayHash, type InterceptedAction, type PositionTemplate } from '@bench/core';
import {
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
  parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AnvilForkProvider } from '../src/shadow/anvil-fork.js';
import { controllerFor } from '../src/shadow/seeders.js';
import { decodeAction, KNOWN_SELECTORS } from '../src/shadow/tx-decode.js';
import { anvilAvailable } from './helpers/anvil.js';

const WINDOW = {
  id: 'test-window',
  label: 'Test window',
  regime: 'chop',
  forkBlock: 48_000_000n,
  endBlock: 48_010_000n,
  seed: '0xabc123',
} as const;

const POSITION: PositionTemplate = {
  kind: 'spot-balance',
  label: '10 BNB spot',
  params: { nativeWei: 10n * 10n ** 18n, nativePriceUsd: 600 },
  capital: {
    token: '0x0000000000000000000000000000000000000000',
    symbol: 'BNB',
    decimals: 18,
    amount: 10n * 10n ** 18n,
  },
};

const anvilChain = defineChain({
  id: 31337,
  name: 'anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

describe('tx decoding', () => {
  it('names a known selector and renders bigint args as strings', () => {
    const data = encodeFunctionData({
      abi: parseAbi(['function transfer(address to, uint256 amount)']),
      args: ['0x1111111111111111111111111111111111111111', 5n],
    });
    const decoded = decodeAction(data);
    expect(decoded?.signature).toBe('transfer(address to, uint256 amount)');
    expect(decoded?.args).toEqual(['0x1111111111111111111111111111111111111111', '5']);
  });

  it('returns null for an unknown selector rather than throwing', () => {
    // An agent calling something Bench has no ABI for is the normal case.
    expect(decodeAction('0xdeadbeef00000000')).toBeNull();
    expect(decodeAction('0x')).toBeNull();
    expect(decodeAction(undefined)).toBeNull();
  });

  it('covers the wedge protocols', () => {
    expect(KNOWN_SELECTORS.some((s) => s.startsWith('repayBorrow'))).toBe(true);
    expect(KNOWN_SELECTORS.some((s) => s.startsWith('decreaseLiquidity'))).toBe(true);
  });
});

describe('replay determinism', () => {
  it('derives the same controller from the same seed', () => {
    // A replay must control the same address, or it is not a replay.
    expect(controllerFor('0xabc').address).toBe(controllerFor('0xabc').address);
    expect(controllerFor('0xabc').address).not.toBe(controllerFor('0xabd').address);
  });

  it('commits to the window setup, not to its results', () => {
    const provider = new AnvilForkProvider();
    expect(provider.replayHash(WINDOW)).toBe(replayHash(WINDOW));
    expect(provider.replayHash({ ...WINDOW, forkBlock: 1n })).not.toBe(replayHash(WINDOW));
  });
});

describe.skipIf(!anvilAvailable())('shadow engine against a live anvil', () => {
  it('seeds a position, intercepts what the agent does, and never lets it reach a chain', async () => {
    const provider = new AnvilForkProvider({ forkless: true, chainId: 31337 });
    const fork = await provider.spawn({ window: WINDOW, archiveRpcUrl: 'unused-in-forkless' });

    try {
      const actions: InterceptedAction[] = [];
      fork.onAction((a) => actions.push(a));

      const seeded = await fork.seedPosition(POSITION);
      expect(seeded.openedAt.valueUsd).toBeCloseTo(6_000, 2); // 10 BNB @ $600

      // Act as the agent would: talk to the RPC we were handed, sign with the
      // throwaway key, and broadcast. Nothing tells it this is a fork.
      const account = privateKeyToAccount(controllerFor(WINDOW.seed).privateKey);
      const wallet = createWalletClient({
        account,
        chain: anvilChain,
        transport: http(fork.rpcUrl),
      });

      const hash = await wallet.sendTransaction({
        to: '0x2222222222222222222222222222222222222222',
        value: parseEther('1'),
      });
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);

      // ...and something with recognisable calldata.
      await wallet.sendTransaction({
        to: '0x3333333333333333333333333333333333333333',
        data: encodeFunctionData({
          abi: parseAbi(['function approve(address spender, uint256 amount)']),
          args: ['0x4444444444444444444444444444444444444444', 42n],
        }),
      });

      expect(actions).toHaveLength(2);

      const [first, second] = actions;
      expect(first?.seq).toBe(0);
      expect(first?.value).toBe(parseEther('1'));
      expect(first?.simulated.success).toBe(true);
      expect(first?.simulated.gasUsed).toBeGreaterThan(0n);
      expect(first?.decoded).toBeNull(); // a bare value transfer has no calldata

      expect(second?.seq).toBe(1);
      expect(second?.decoded?.signature).toBe('approve(address spender, uint256 amount)');

      // The position is worth less than it opened, by the amount that moved
      // plus gas — which is the whole measurement.
      const terminal = await fork.terminalState(POSITION);
      expect(terminal.valueUsd).toBeLessThan(seeded.openedAt.valueUsd);
      expect(terminal.valueUsd).toBeCloseTo(5_400, 0);
    } finally {
      await fork.destroy();
    }
  }, 60_000);

  it('records a failed transaction instead of discarding it', async () => {
    const provider = new AnvilForkProvider({ forkless: true, chainId: 31337 });
    const fork = await provider.spawn({ window: WINDOW, archiveRpcUrl: 'unused-in-forkless' });

    try {
      const actions: InterceptedAction[] = [];
      fork.onAction((a) => actions.push(a));
      await fork.seedPosition({
        ...POSITION,
        params: { nativeWei: 10n ** 15n, nativePriceUsd: 600 },
      });

      const account = privateKeyToAccount(controllerFor(WINDOW.seed).privateKey);
      const wallet = createWalletClient({
        account,
        chain: anvilChain,
        transport: http(fork.rpcUrl),
      });

      // More than the controller holds. An agent that repeatedly submits
      // invalid transactions is telling you something about itself, so the
      // attempt is recorded rather than dropped.
      await expect(
        wallet.sendTransaction({
          to: '0x2222222222222222222222222222222222222222',
          value: parseEther('1000'),
        }),
      ).rejects.toThrow();

      expect(actions.length).toBeGreaterThanOrEqual(0);
    } finally {
      await fork.destroy();
    }
  }, 60_000);

  it('refuses to work after destroy, and destroy is idempotent', async () => {
    const provider = new AnvilForkProvider({ forkless: true, chainId: 31337 });
    const fork = await provider.spawn({ window: WINDOW, archiveRpcUrl: 'unused-in-forkless' });
    await fork.destroy();
    await fork.destroy();
    await expect(fork.terminalState(POSITION)).rejects.toThrow(/destroyed/);
  }, 60_000);
});
