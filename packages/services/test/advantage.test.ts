import { describe, expect, it } from 'vitest';
import type { AuditionEvidence, AuditionStore } from '@bench/core';
import { buildAdvantageReport } from '../src/advantage.js';

/**
 * The Agent Advantage Report is a required deliverable, and a missing one is
 * disqualifying. These pin the arithmetic that decides whether an agent is
 * reported as having helped - the number a hand-written report gets to choose.
 */
const evidence = (over: Partial<AuditionEvidence> = {}): AuditionEvidence => ({
  run: {
    id: 'run-1',
    agent: { chain: 'bsc-testnet', tokenId: 7n },
    window: {
      id: 'w',
      label: 'Recent market',
      regime: 'live',
      forkBlock: 119_424_000n,
      endBlock: 119_429_000n,
      seed: 's',
    },
    position: { kind: 'spot-balance', label: '10,000 USDT', params: {}, capital: {} as never },
    status: 'complete',
    startedAt: new Date('2026-09-03T10:00:00Z'),
    finishedAt: new Date('2026-09-03T10:00:42Z'),
    egressSpentUsd: 0.02,
    gasSpentUsd: 0.31,
  },
  outcome: {
    runId: 'run-1',
    terminal: { valueUsd: 10_120, detail: {} },
    deltaVsDoNothingUsd: 120,
    deltaVsPeerMedianUsd: null,
    maxDrawdownUsd: 15,
    actionCount: 2,
  },
  replayHash: '0xabc',
  agentName: 'Rebalancer',
  category: 'rebalancing',
  actions: [],
  ...over,
});

const storeOf = (items: readonly AuditionEvidence[]): AuditionStore =>
  ({ completedAuditions: async () => items }) as unknown as AuditionStore;

describe('buildAdvantageReport', () => {
  it('derives the baseline from the delta rather than measuring it twice', async () => {
    // The delta is defined as agent-minus-do-nothing over the same window, so
    // the control is one subtraction away and cannot drift from the figure it
    // is supposed to explain.
    const r = await buildAdvantageReport(storeOf([evidence()]), 'bsc-testnet');
    expect(r.tasks[0]?.withAgent.terminalUsd).toBe(10_120);
    expect(r.tasks[0]?.withoutAgent.terminalUsd).toBe(10_000);
    expect(r.tasks[0]?.deltaUsd).toBe(120);
  });

  it('counts a win only when the gain exceeds what the run cost', async () => {
    // An agent that gains three dollars while spending five on data has not
    // helped anyone, and counting that as a win is how these reports usually
    // flatter their subject.
    const marginal = evidence({
      outcome: { ...evidence().outcome, deltaVsDoNothingUsd: 3 },
      run: { ...evidence().run, egressSpentUsd: 5 },
    });
    const r = await buildAdvantageReport(storeOf([marginal]), 'bsc-testnet');
    expect(r.tasks[0]?.deltaUsd).toBe(3);
    expect(r.tasks[0]?.agentWon).toBe(false);
    expect(r.totals.agentWins).toBe(0);
  });

  it('reports a loss as a loss', async () => {
    const losing = evidence({
      outcome: {
        ...evidence().outcome,
        deltaVsDoNothingUsd: -80,
        terminal: { valueUsd: 9_920, detail: {} },
      },
    });
    const r = await buildAdvantageReport(storeOf([losing]), 'bsc-testnet');
    expect(r.tasks[0]?.withoutAgent.terminalUsd).toBe(10_000);
    expect(r.tasks[0]?.agentWon).toBe(false);
    expect(r.totals.netDeltaUsd).toBe(-80);
  });

  it('reports the task minimum honestly instead of padding to it', async () => {
    // Three is the brief's floor. Inventing a third task so the badge turns
    // green is the exact failure this report exists to guard against.
    const two = await buildAdvantageReport(storeOf([evidence(), evidence()]), 'bsc-testnet');
    expect(two.meetsTaskMinimum).toBe(false);

    const three = await buildAdvantageReport(
      storeOf([evidence(), evidence(), evidence()]),
      'bsc-testnet',
    );
    expect(three.meetsTaskMinimum).toBe(true);
  });

  it('checks the high-stakes category requirement against real categories', async () => {
    const other = evidence({ category: 'other' });
    expect(
      (await buildAdvantageReport(storeOf([other]), 'bsc-testnet')).meetsCategoryRequirement,
    ).toBe(false);

    const grid = evidence({ category: 'grid' });
    expect(
      (await buildAdvantageReport(storeOf([grid]), 'bsc-testnet')).meetsCategoryRequirement,
    ).toBe(true);
  });

  it('attaches the outputs, including reverted ones', async () => {
    // A reverted transaction is part of what the agent did, and dropping it
    // would make the attached outputs a curated selection.
    const withActions = evidence({
      actions: [
        {
          seq: 0,
          at: new Date(),
          to: '0x1111111111111111111111111111111111111111',
          value: 10n ** 18n,
          data: '0xa9059cbb0000',
          decoded: null,
          simulated: { success: false, gasUsed: 21_000n, revertReason: 'insufficient balance' },
        },
      ],
    });
    const r = await buildAdvantageReport(storeOf([withActions]), 'bsc-testnet');
    expect(r.tasks[0]?.withAgent.actions[0]?.selector).toBe('0xa9059cbb');
    expect(r.tasks[0]?.withAgent.actions[0]?.succeeded).toBe(false);
    expect(r.tasks[0]?.withAgent.actions[0]?.valueWei).toBe('1000000000000000000');
  });

  it('reports wall clock, and null rather than zero when it was not recorded', async () => {
    const timed = await buildAdvantageReport(storeOf([evidence()]), 'bsc-testnet');
    expect(timed.tasks[0]?.withAgent.durationMs).toBe(42_000);

    const untimed = evidence({ run: { ...evidence().run, startedAt: null, finishedAt: null } });
    const r = await buildAdvantageReport(storeOf([untimed]), 'bsc-testnet');
    expect(r.tasks[0]?.withAgent.durationMs).toBeNull();
  });

  it('is empty rather than invented when there is no evidence', async () => {
    const r = await buildAdvantageReport(storeOf([]), 'bsc-testnet');
    expect(r.tasks).toEqual([]);
    expect(r.meetsTaskMinimum).toBe(false);
    expect(r.totals.netDeltaUsd).toBe(0);
  });
});
