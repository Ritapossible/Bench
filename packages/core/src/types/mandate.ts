import { createHash } from 'node:crypto';
import type { AgentId } from './agent.js';
import { formatBaseUnits, formatTokenAmount } from './primitives.js';
import type { Address, Hex, TokenAmount } from './primitives.js';

/**
 * The signed bounded mandate — the unit of authority a hired agent carries.
 *
 * **A permission slip, not a blank cheque.** The agent never holds the owner's
 * key; it holds a mandate the owner signed, stating exactly how much, to whom,
 * for how long. Everything downstream checks against this rather than against
 * a rule someone remembered to apply.
 *
 * This is the *authorization* bound. It is independent of the *behavioural*
 * bound in envelope.ts, and a transaction must clear both:
 *
 * | Rule | Enforced where | Why there |
 * |---|---|---|
 * | per-tx cap, total cap, allowlist | session-key contract, on-chain | a violating transaction cannot be signed at all |
 * | expiry, revocation | on-chain state | consensus beats a valid signature — revoke must win even against a correctly signed transaction |
 * | behavioural envelope | the gate, before signing | derived from audition evidence, so it lives where that evidence does |
 * | approval threshold ("ask above X") | the dashboard | a comfort line the owner changes at UI speed, never a security boundary |
 *
 * Putting a rule at the wrong layer is the classic failure: a cap enforced only
 * in the client is a cap the client can be persuaded to skip.
 */

export interface MandateBounds {
  /** Ceiling across the whole hire. */
  readonly totalSpendCap: TokenAmount;
  /** Ceiling for any single transaction. */
  readonly perTxCap: TokenAmount;
  /** Contracts and accounts the agent may touch. Empty means none. */
  readonly contractAllowlist: readonly Address[];
  readonly expiresAt: Date;
  /** Belt-and-braces against a loop that stays individually in-cap. */
  readonly maxActions: number;
}

export interface HireMandate {
  readonly id: string;
  /** Bumped whenever the encoding changes, so old signatures cannot be replayed under new rules. */
  readonly version: 1;
  readonly hireId: string;
  readonly owner: Address;
  readonly agent: AgentId;
  /** The session key this mandate authorises. */
  readonly sessionKey: Address;
  readonly bounds: MandateBounds;
  /** Replay protection. */
  readonly nonce: Hex;
  readonly issuedAt: Date;
}

/** Live counters. Kept separate from the mandate because the mandate is immutable once signed. */
export interface MandateState {
  readonly spent: bigint;
  readonly actions: number;
  readonly revokedAt: Date | null;
}

export const EMPTY_MANDATE_STATE: MandateState = { spent: 0n, actions: 0, revokedAt: null };

export type MandateRule =
  | 'revoked'
  | 'expired'
  | 'per-tx-cap-exceeded'
  | 'total-cap-exceeded'
  | 'contract-not-allowlisted'
  | 'action-limit-reached'
  | 'wrong-token';

export interface MandateDecision {
  readonly allowed: boolean;
  readonly rules: readonly MandateRule[];
  readonly explanation: string;
}

export interface MandateCandidate {
  readonly to: Address | null;
  readonly value: bigint;
  readonly token: Address;
}

/**
 * Canonical encoding for signing.
 *
 * Every field is length-delimited for the same reason `encodeProbe` is: without
 * it, an allowlist entry containing the separator could produce the identical
 * byte string as a different mandate, and a signature over one would authorise
 * the other. Field order is fixed and the allowlist is sorted, so two encoders
 * cannot disagree.
 */
export function encodeMandate(m: HireMandate): string {
  const parts = [
    `v${m.version}`,
    m.id,
    m.hireId,
    m.owner.toLowerCase(),
    m.agent.chain,
    m.agent.tokenId.toString(),
    m.sessionKey.toLowerCase(),
    m.bounds.totalSpendCap.token.toLowerCase(),
    m.bounds.totalSpendCap.amount.toString(),
    m.bounds.perTxCap.amount.toString(),
    [...m.bounds.contractAllowlist]
      .map((a) => a.toLowerCase())
      .sort()
      .join(','),
    m.bounds.expiresAt.toISOString(),
    String(m.bounds.maxActions),
    m.nonce,
    m.issuedAt.toISOString(),
  ];
  return parts.map((f) => `${f.length}:${f}`).join('|');
}

/** What the owner signs, and what any verifier recomputes. */
export function mandateDigest(m: HireMandate): Hex {
  return `0x${createHash('sha256').update(encodeMandate(m), 'utf8').digest('hex')}` as Hex;
}

/**
 * The authorization check. Pure, total and synchronous so it can be unit-tested
 * exhaustively and recomputed later from stored state without a chain.
 *
 * Order matters for the explanation, not the outcome: revocation and expiry are
 * reported first because they are terminal, and a user reading a refusal should
 * see "this mandate is dead" before "and also the amount was too high".
 */
export function checkMandate(
  candidate: MandateCandidate,
  mandate: HireMandate,
  state: MandateState,
  now: Date = new Date(),
): MandateDecision {
  const rules: MandateRule[] = [];

  if (state.revokedAt !== null) rules.push('revoked');
  if (now.getTime() >= mandate.bounds.expiresAt.getTime()) rules.push('expired');

  if (candidate.token.toLowerCase() !== mandate.bounds.totalSpendCap.token.toLowerCase()) {
    rules.push('wrong-token');
  }
  if (candidate.value > mandate.bounds.perTxCap.amount) rules.push('per-tx-cap-exceeded');
  if (state.spent + candidate.value > mandate.bounds.totalSpendCap.amount)
    rules.push('total-cap-exceeded');
  if (state.actions + 1 > mandate.bounds.maxActions) rules.push('action-limit-reached');

  if (
    candidate.to === null ||
    !mandate.bounds.contractAllowlist.some((a) => a.toLowerCase() === candidate.to?.toLowerCase())
  ) {
    rules.push('contract-not-allowlisted');
  }

  return {
    allowed: rules.length === 0,
    rules,
    explanation: rules.length === 0 ? '' : explain(rules, candidate, mandate, state),
  };
}

function explain(
  rules: readonly MandateRule[],
  c: MandateCandidate,
  m: HireMandate,
  s: MandateState,
): string {
  const dp = m.bounds.totalSpendCap.decimals;
  const amt = (v: bigint) => `${formatBaseUnits(v, dp)} ${m.bounds.totalSpendCap.symbol}`;
  const parts = rules.map((r) => {
    switch (r) {
      case 'revoked':
        return `the mandate was revoked at ${s.revokedAt?.toISOString() ?? 'an earlier time'}`;
      case 'expired':
        return `the mandate expired at ${m.bounds.expiresAt.toISOString()}`;
      case 'wrong-token':
        return `it spends ${c.token}, but the mandate covers ${m.bounds.totalSpendCap.token}`;
      case 'per-tx-cap-exceeded':
        return `it moves ${amt(c.value)} against a per-transaction cap of ${formatTokenAmount(m.bounds.perTxCap)}`;
      case 'total-cap-exceeded':
        return `it would take this hire to ${amt(s.spent + c.value)} against a total cap of ${formatTokenAmount(m.bounds.totalSpendCap)}`;
      case 'action-limit-reached':
        return `it is action ${s.actions + 1} against a limit of ${m.bounds.maxActions}`;
      case 'contract-not-allowlisted':
        return `${c.to ?? 'contract creation'} is not on the mandate's allowlist`;
      default: {
        const exhaustive: never = r;
        return String(exhaustive);
      }
    }
  });
  return `Refused: ${parts.join('; and ')}.`;
}

/** Applied after a transaction is admitted, so the next check sees the truth. */
export function applySpend(state: MandateState, value: bigint): MandateState {
  return { ...state, spent: state.spent + value, actions: state.actions + 1 };
}

export const revoke = (state: MandateState, at: Date = new Date()): MandateState =>
  state.revokedAt === null ? { ...state, revokedAt: at } : state;

/** Remaining headroom, for the hire dashboard. */
export function remaining(
  mandate: HireMandate,
  state: MandateState,
): {
  readonly spend: bigint;
  readonly actions: number;
  readonly msUntilExpiry: number;
} {
  return {
    spend: mandate.bounds.totalSpendCap.amount - state.spent,
    actions: mandate.bounds.maxActions - state.actions,
    msUntilExpiry: mandate.bounds.expiresAt.getTime() - Date.now(),
  };
}
