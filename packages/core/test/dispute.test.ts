import { describe, expect, it } from 'vitest';
import {
  applyConfidenceFloor,
  bindingFindings,
  classifyEvidence,
  deriveDisputeRuling,
  evidenceIndependence,
  hasIndependentEvidence,
  replayAgainstTerms,
  type DisputedAction,
} from '../src/types/dispute.js';
import { deriveEnvelope } from '../src/types/envelope.js';
import type { HireMandate } from '../src/types/mandate.js';
import type { Address, Hex } from '../src/types/primitives.js';

const OWNER = `0x${'11'.repeat(20)}` as Address;
const KEY = `0x${'22'.repeat(20)}` as Address;
const POOL = `0x${'33'.repeat(20)}` as Address;
const STRANGER = `0x${'99'.repeat(20)}` as Address;
const USDT = `0x55d398326f99059ff775485246999027b3197955` as Address;
const SWAP = '0x38ed1739' as Hex;

const T0 = new Date('2026-09-01T00:00:00.000Z');
const at = (mins: number): Date => new Date(T0.getTime() + mins * 60_000);

const action = (seq: number, over: Partial<DisputedAction> = {}): DisputedAction => ({
  seq,
  at: at(seq),
  to: POOL,
  value: 10n ** 17n, // 0.1
  data: SWAP,
  decoded: null,
  simulated: { success: true, gasUsed: 21_000n },
  ...over,
});

const mandate = (over: Partial<HireMandate['bounds']> = {}): HireMandate => ({
  id: 'm-1',
  version: 1,
  hireId: 'h-1',
  owner: OWNER,
  agent: { chain: 'bsc-mainnet', tokenId: 346_444n },
  sessionKey: KEY,
  bounds: {
    totalSpendCap: { token: USDT, symbol: 'USDT', decimals: 18, amount: 10n ** 18n },
    perTxCap: { token: USDT, symbol: 'USDT', decimals: 18, amount: 5n * 10n ** 17n },
    contractAllowlist: [POOL],
    expiresAt: at(60),
    maxActions: 5,
    ...over,
  },
  nonce: '0xdeadbeef' as Hex,
  issuedAt: T0,
});

/** Three runs, so the envelope is not thin and its rules bind. */
const envelope = (runs = 3) =>
  deriveEnvelope(
    Array.from({ length: runs }, () => ({
      actions: [action(1), action(2)],
      positionDropUsd: 5,
    })),
  );

describe('replayAgainstTerms', () => {
  it('finds nothing in a hire that stayed inside its terms', () => {
    const audit = replayAgainstTerms([action(1), action(2)], mandate(), envelope());
    expect(audit.findings).toEqual([]);
    expect(audit.actionsConsidered).toBe(2);
    expect(audit.envelopeAdvisory).toBe(false);
  });

  it('catches a payment to an address the mandate never allowed', () => {
    const audit = replayAgainstTerms(
      [action(1), action(2, { to: STRANGER })],
      mandate(),
      envelope(),
    );
    const rules = audit.findings.map((f) => f.rule);
    expect(rules).toContain('contract-not-allowlisted');
    // And the behavioural bound catches it independently, which is the point of
    // having two: an allowlist can be generous and still be a real boundary.
    expect(rules).toContain('unseen-recipient');
    expect(audit.findings.every((f) => f.seq === 2)).toBe(true);
  });

  it('counts spend across the whole hire, not per transaction', () => {
    // Each is inside the per-tx cap; together they pass the total.
    const big = { value: 4n * 10n ** 17n };
    const audit = replayAgainstTerms(
      [action(1, big), action(2, big), action(3, big)],
      mandate(),
      envelope(),
    );
    expect(audit.findings.map((f) => f.rule)).toContain('total-cap-exceeded');
    expect(audit.findings.some((f) => f.rule === 'per-tx-cap-exceeded')).toBe(false);
  });

  it('keeps counting spend on an action that already broke a rule', () => {
    /**
     * A replay that skipped the refused action's value would under-count the
     * total and clear a hire that blew its cap on the transaction after the
     * one that first went wrong.
     */
    const audit = replayAgainstTerms(
      [action(1, { to: STRANGER, value: 9n * 10n ** 17n }), action(2, { value: 2n * 10n ** 17n })],
      mandate(),
      envelope(),
    );
    const totals = audit.findings.filter((f) => f.rule === 'total-cap-exceeded');
    expect(totals.map((f) => f.seq)).toEqual([2]);
  });

  it('judges each action by the clock when it happened', () => {
    /**
     * A mandate that has since expired did not expire retroactively over
     * transactions sent while it was live. Judging the record against the clock
     * at adjudication would find `expired` in every hire that ever completed.
     */
    const audit = replayAgainstTerms([action(1), action(2)], mandate(), envelope());
    expect(audit.findings.some((f) => f.rule === 'expired')).toBe(false);

    const late = replayAgainstTerms([action(1), action(2, { at: at(120) })], mandate(), envelope());
    expect(late.findings.filter((f) => f.rule === 'expired').map((f) => f.seq)).toEqual([2]);
  });

  it('reads the record in sequence order however it arrives', () => {
    const shuffled = replayAgainstTerms(
      [action(3, { value: 4n * 10n ** 17n }), action(1), action(2, { value: 4n * 10n ** 17n })],
      mandate(),
      envelope(),
    );
    const ordered = replayAgainstTerms(
      [action(1), action(2, { value: 4n * 10n ** 17n }), action(3, { value: 4n * 10n ** 17n })],
      mandate(),
      envelope(),
    );
    expect(shuffled.findings).toEqual(ordered.findings);
  });

  it('catches a call the agent never made in audition', () => {
    const audit = replayAgainstTerms(
      [action(1, { data: '0xdeadbeef' as Hex })],
      mandate(),
      envelope(),
    );
    expect(audit.findings.map((f) => f.rule)).toContain('unseen-call');
  });
});

describe('bindingFindings', () => {
  it('will not settle a dispute on an envelope built from one run', () => {
    const thin = replayAgainstTerms([action(1, { to: STRANGER })], mandate(), envelope(1));
    expect(thin.envelopeAdvisory).toBe(true);
    // Both rules are reported...
    expect(thin.findings.map((f) => f.rule)).toContain('unseen-recipient');
    // ...and only the one the owner signed can settle anything.
    const binding = bindingFindings(thin).map((f) => f.rule);
    expect(binding).toContain('contract-not-allowlisted');
    expect(binding).not.toContain('unseen-recipient');
  });

  it('lets envelope rules bind once the envelope has a sample behind it', () => {
    const thick = replayAgainstTerms([action(1, { to: STRANGER })], mandate(), envelope(3));
    expect(thick.envelopeAdvisory).toBe(false);
    expect(bindingFindings(thick).map((f) => f.rule)).toContain('unseen-recipient');
  });
});

describe('classifyEvidence', () => {
  const parties = {
    claimantDomain: 'client.example',
    respondentDomain: 'agent.example',
    marketplaceDomain: 'bench-bnb.vercel.app',
  };

  it('separates the marketplace from independent sources', () => {
    // Bench is not a bystander: it lists the agent, ranks it, and profits from
    // the hire. Folding its API into "independent" would flatter every ruling.
    expect(classifyEvidence('https://bench-bnb.vercel.app/api/runs/1', parties)).toBe(
      'marketplace',
    );
    expect(classifyEvidence('https://bscscan.com/tx/0xabc', parties)).toBe('independent');
  });

  it('attributes a subdomain to the party that owns the domain', () => {
    expect(classifyEvidence('https://status.agent.example/uptime', parties)).toBe('respondent');
    expect(classifyEvidence('https://client.example/ticket/9', parties)).toBe('claimant');
  });

  it('does not let a lookalike domain pass as a party', () => {
    expect(classifyEvidence('https://notagent.example/x', parties)).toBe('independent');
    expect(classifyEvidence('https://agent.example.evil.com/x', parties)).toBe('independent');
  });

  it('refuses to classify anything that is not https', () => {
    expect(classifyEvidence('http://agent.example/x', parties)).toBe('unclassified');
    expect(classifyEvidence('not a url', parties)).toBe('unclassified');
  });
});

describe('evidenceIndependence', () => {
  it('tallies what a ruling was actually read from', () => {
    const tally = evidenceIndependence([
      { url: 'https://bscscan.com/a', origin: 'independent' },
      { url: 'https://agent.example/b', origin: 'respondent' },
      { url: 'https://agent.example/c', origin: 'respondent' },
    ]);
    expect(tally).toEqual({
      independent: 1,
      claimant: 0,
      respondent: 2,
      marketplace: 0,
      unclassified: 0,
    });
    expect(hasIndependentEvidence(tally)).toBe(true);
  });

  it('says so when every source belongs to an interested party', () => {
    const tally = evidenceIndependence([
      { url: 'https://bench-bnb.vercel.app/x', origin: 'marketplace' },
      { url: 'https://agent.example/y', origin: 'respondent' },
    ]);
    expect(hasIndependentEvidence(tally)).toBe(false);
  });
});

describe('deriveDisputeRuling', () => {
  it('upholds on one unmet criterion - the claimant need only be right once', () => {
    expect(
      deriveDisputeRuling([
        { id: 1, status: 'met', confidence: 90 },
        { id: 2, status: 'unmet', confidence: 90 },
      ]),
    ).toBe('upheld');
  });

  it('dismisses only when every criterion was met', () => {
    expect(
      deriveDisputeRuling([
        { id: 1, status: 'met', confidence: 90 },
        { id: 2, status: 'met', confidence: 80 },
      ]),
    ).toBe('dismissed');
  });

  it('falls to unresolved rather than guessing', () => {
    expect(
      deriveDisputeRuling([
        { id: 1, status: 'met', confidence: 90 },
        { id: 2, status: 'unresolved', confidence: 0 },
      ]),
    ).toBe('unresolved');
    expect(deriveDisputeRuling([])).toBe('unresolved');
  });
});

describe('applyConfidenceFloor', () => {
  it('downgrades a low-confidence accusation, never a low-confidence clearance', () => {
    /**
     * Upholding takes money from a party that may have delivered, so it needs
     * conviction. Dismissing leaves the escrow to settle exactly as the parties
     * already agreed it would, so it does not.
     */
    const readings = applyConfidenceFloor([
      { id: 1, status: 'unmet', confidence: 50 },
      { id: 2, status: 'met', confidence: 50 },
    ]);
    expect(readings[0]?.status).toBe('unresolved');
    expect(readings[1]?.status).toBe('met');
    expect(deriveDisputeRuling(readings)).toBe('unresolved');
  });

  it('keeps an accusation the model was sure about', () => {
    const readings = applyConfidenceFloor([{ id: 1, status: 'unmet', confidence: 95 }]);
    expect(deriveDisputeRuling(readings)).toBe('upheld');
  });
});
