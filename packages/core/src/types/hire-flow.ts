import { createHash } from 'node:crypto';
import { BenchError } from './primitives.js';
import type { Hex } from './primitives.js';
import type { MandateRule } from './mandate.js';
import type { EnvelopeRule } from './envelope.js';

/**
 * The hire lifecycle, its audit trail, and the consent it requires.
 *
 * Written as an explicit machine rather than a status string that anything can
 * assign, because the failure this prevents is real money: a hire that reaches
 * `active` without passing through `funded` is an agent spending against an
 * escrow that was never filled.
 */

export type HireState =
  | 'draft'
  | 'quoted'
  | 'authorized'
  | 'funded'
  | 'active'
  | 'settling'
  | 'settled'
  | 'revoked'
  | 'failed';

/**
 * Legal transitions. Anything absent here is a bug, not a state.
 *
 * `revoked` is reachable from every live state — a kill switch that only works
 * from some states is not a kill switch. `failed` likewise, so a partial
 * failure is always representable rather than leaving a hire stuck.
 *
 * Revoking a `draft` or a `quoted` hire is arguably meaningless, since no
 * authority exists yet to withdraw. It is permitted anyway: uniformity means a
 * UI can offer revoke unconditionally without inspecting state, and the special
 * case is exactly where a "revoke did nothing" bug would live. A revoked draft
 * is simply a draft nobody will continue.
 */
export const HIRE_TRANSITIONS: Readonly<Record<HireState, readonly HireState[]>> = {
  draft: ['quoted', 'revoked', 'failed'],
  quoted: ['authorized', 'revoked', 'failed'],
  authorized: ['funded', 'revoked', 'failed'],
  funded: ['active', 'revoked', 'failed'],
  active: ['settling', 'revoked', 'failed'],
  settling: ['settled', 'revoked', 'failed'],
  settled: [],
  revoked: [],
  failed: [],
};

export const isTerminal = (s: HireState): boolean => HIRE_TRANSITIONS[s].length === 0;

export const canTransition = (from: HireState, to: HireState): boolean =>
  HIRE_TRANSITIONS[from].includes(to);

/** Throws rather than returning false: an illegal transition is never recoverable by guessing. */
export function assertTransition(from: HireState, to: HireState): void {
  if (!canTransition(from, to)) {
    throw new BenchError(
      'NOT_SUPPORTED_BY_PROVIDER',
      `illegal hire transition ${from} → ${to}; legal from ${from}: ${HIRE_TRANSITIONS[from].join(', ') || '(terminal)'}`,
    );
  }
}

/* ------------------------------------------------------------------ trace */

export type TraceStep =
  | 'quote'
  | 'consent'
  | 'authorize'
  | 'fund'
  | 'mint-session-key'
  | 'gate-check'
  | 'mandate-check'
  | 'submit'
  | 'settle'
  | 'dispute'
  | 'revoke';

export type TraceOutcome = 'ok' | 'blocked' | 'failed';

export interface TraceEntry {
  readonly seq: number;
  readonly at: Date;
  readonly step: TraceStep;
  readonly outcome: TraceOutcome;
  /** Which rule decided, when one did. Both bounds report into the same trace. */
  readonly rules: readonly (MandateRule | EnvelopeRule)[];
  readonly detail: string;
  /** Hash chain over every prior entry. Rewriting history invalidates the tail. */
  readonly digest: Hex;
}

export const TRACE_GENESIS: Hex = `0x${'00'.repeat(32)}` as Hex;

/**
 * Append to a decision trace.
 *
 * Chained rather than a list of independent records, for the same reason the
 * probe anchor is: a trace that can be edited after the fact proves nothing,
 * and this is the artifact a user reads when an agent did something they did
 * not expect. Verifiable with `verifyTrace` and nothing else.
 */
export function appendTrace(
  previous: readonly TraceEntry[],
  entry: Omit<TraceEntry, 'seq' | 'digest'>,
): readonly TraceEntry[] {
  const prev = previous[previous.length - 1]?.digest ?? TRACE_GENESIS;
  const seq = previous.length;
  return [...previous, { ...entry, seq, digest: traceDigest(prev, { ...entry, seq }) }];
}

function traceDigest(previous: Hex, e: Omit<TraceEntry, 'digest'>): Hex {
  const parts = [
    previous,
    String(e.seq),
    e.at.toISOString(),
    e.step,
    e.outcome,
    [...e.rules].sort().join(','),
    e.detail,
  ];
  const canonical = parts.map((f) => `${f.length}:${f}`).join('|');
  return `0x${createHash('sha256').update(canonical, 'utf8').digest('hex')}` as Hex;
}

/** Recompute the chain. Returns the index of the first tampered entry, or null. */
export function verifyTrace(trace: readonly TraceEntry[]): number | null {
  let prev = TRACE_GENESIS;
  for (let i = 0; i < trace.length; i += 1) {
    const e = trace[i]!;
    if (e.seq !== i) return i;
    const { digest, ...rest } = e;
    if (traceDigest(prev, rest) !== digest) return i;
    prev = digest;
  }
  return null;
}

/* ---------------------------------------------------------------- consent */

/**
 * The consent checklist.
 *
 * Modelled on the one marketplace behaviour in this space that is unusually
 * disciplined about it: an ordered set of confirmations that **refuses to skip
 * ahead**, rather than a single "I agree" that means nothing. Each step is a
 * separate decision the owner makes, and the summary step exists so that
 * nobody confirms a set of bounds they never saw together.
 *
 * The steps are ordered by consequence, cheapest to reverse first.
 */
export const CONSENT_STEPS = [
  'reviewed-audition',
  'set-spend-cap',
  'set-allowlist',
  'set-expiry',
  'reviewed-summary',
] as const;

export type ConsentStep = (typeof CONSENT_STEPS)[number];

export const CONSENT_PROMPTS: Readonly<Record<ConsentStep, string>> = {
  'reviewed-audition': 'Read what this agent did in audition, and against what baseline.',
  'set-spend-cap': 'Set the total and per-transaction ceilings.',
  'set-allowlist': 'Choose which contracts it may touch.',
  'set-expiry': 'Choose when this authority ends by itself.',
  'reviewed-summary': 'Confirm every bound above, together, as one decision.',
};

/** The next step, or null when consent is complete. Never skips. */
export function nextConsentStep(confirmed: readonly ConsentStep[]): ConsentStep | null {
  return CONSENT_STEPS.find((s) => !confirmed.includes(s)) ?? null;
}

/**
 * Confirm a step, refusing anything out of order.
 *
 * A UI could of course present them in any order, but the domain will not
 * record a later confirmation before an earlier one — which is what stops a
 * client bug, or a hurried user, from producing a mandate whose bounds nobody
 * actually looked at.
 */
export function confirmConsent(
  confirmed: readonly ConsentStep[],
  step: ConsentStep,
): readonly ConsentStep[] {
  if (confirmed.includes(step)) return confirmed;
  const expected = nextConsentStep(confirmed);
  if (expected !== step) {
    throw new BenchError(
      'NOT_SUPPORTED_BY_PROVIDER',
      `consent step "${step}" is out of order; "${expected ?? '(none)'}" comes next`,
    );
  }
  return [...confirmed, step];
}

export const consentComplete = (confirmed: readonly ConsentStep[]): boolean =>
  nextConsentStep(confirmed) === null;
