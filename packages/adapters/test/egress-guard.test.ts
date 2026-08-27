import { BenchError } from '@bench/core';
import { describe, expect, it } from 'vitest';
import { InMemoryEgressGuard } from '../src/shadow/egress-guard.js';

const guard = () => new InMemoryEgressGuard({ budgetUsd: 0.25, allowlist: ['api.example.com'] });

describe('EgressGuard', () => {
  it('denies hosts that are not allowlisted', async () => {
    const d = await guard().check('run-1', 'evil.example.net', 0.001);
    expect(d).toEqual({ allowed: false, reason: 'host-not-allowlisted' });
  });

  it('allows an allowlisted host inside budget', async () => {
    const d = await guard().check('run-1', 'api.example.com', 0.01);
    expect(d.allowed).toBe(true);
  });

  it('denies a call that would cross the budget', async () => {
    const g = guard();
    await g.record('run-1', 0.24);
    const d = await g.check('run-1', 'api.example.com', 0.02);
    expect(d).toEqual({ allowed: false, reason: 'over-budget' });
  });

  it('tracks budget per run, not globally', async () => {
    const g = guard();
    await g.record('run-1', 0.24);
    const d = await g.check('run-2', 'api.example.com', 0.2);
    expect(d.allowed).toBe(true);
  });

  it('throws when recorded actuals exceed the budget', async () => {
    const g = guard();
    await expect(g.record('run-1', 0.9)).rejects.toBeInstanceOf(BenchError);
    await expect(g.record('run-2', 0.9)).rejects.toMatchObject({
      code: 'EGRESS_BUDGET_EXCEEDED',
    });
  });

  it('reports spend for a run', async () => {
    const g = guard();
    await g.record('run-1', 0.1);
    await g.record('run-1', 0.05);
    expect(await g.spent('run-1')).toBeCloseTo(0.15);
    expect(await g.spent('never-ran')).toBe(0);
  });
});
