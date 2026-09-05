import { describe, expect, it } from 'vitest';
import { looksLikeTestRegistration } from '../src/test-registration.js';

describe('looksLikeTestRegistration', () => {
  it('catches the scaffolding that filled the first report', () => {
    // Every name here is on chain in the ERC-8004 registry on BSC testnet and
    // appeared above the fold in the report for 0xf46a92c8….
    for (const name of [
      'studio-agent',
      'BNB Testnet Starter',
      'LingoAI Portfolio Rebalancer (demo)',
      'LingoAI Health Factor Sentinel (demo)',
      'LingoAI Yield Optimiser (demo)',
      'LingoAI Grid Trading Agent (demo)',
    ]) {
      expect(looksLikeTestRegistration(name), name).toBe(true);
    }
  });

  it('reads a clean name with a self-declaring description', () => {
    expect(looksLikeTestRegistration('Alpha Engine', 'A demo agent, do not hire')).toBe(true);
  });

  it('keeps agents that are merely unfamiliar or irrelevant', () => {
    // The rule is self-declaration, not usefulness. A Swahili translator has
    // nothing to do with a USDT position, and irrelevant is not fake.
    for (const name of [
      'ProofEra LP Risk Evidence Agent',
      'bubbleaiagent',
      'bnbcopyscout',
      'My Personal Holon - Swahili Translation',
      'IVL Rebalancer',
      'BNB Grid Trader',
      'AgentSentinel Guardian',
      'Bit Monk',
    ]) {
      expect(looksLikeTestRegistration(name), name).toBe(false);
    }
  });

  it('matches whole words, so real names survive their substrings', () => {
    // `test` inside `Latest` and `Contest`, `demo` inside `Demography`. The
    // scaffold list is matched whole, so an agent that chose `Studio` as part
    // of its own name keeps it.
    expect(looksLikeTestRegistration('Latest Yield Router')).toBe(false);
    expect(looksLikeTestRegistration('Contest Watcher')).toBe(false);
    expect(looksLikeTestRegistration('Demography Signals')).toBe(false);
    expect(looksLikeTestRegistration('Grid Studio Agent')).toBe(false);
  });

  it('treats a hyphen as a word boundary, both ways', () => {
    // The trade this rule makes: `demo-agent` is a declaration, and so is any
    // name built out of `starter`. Stated rather than discovered later.
    expect(looksLikeTestRegistration('demo-agent')).toBe(true);
    expect(looksLikeTestRegistration('starter-pack-optimiser')).toBe(true);
  });

  it('does not exclude an agent for having no name at all', () => {
    // An empty name is a card-parsing problem, and hiding it would remove the
    // evidence rather than the agent.
    expect(looksLikeTestRegistration('')).toBe(false);
    expect(looksLikeTestRegistration('   ')).toBe(false);
  });
});
