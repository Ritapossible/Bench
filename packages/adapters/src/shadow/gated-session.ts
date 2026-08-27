import {
  checkAgainstEnvelope,
  type BehaviouralEnvelope,
  type CandidateAction,
  type EnvelopePolicy,
  type GateDecision,
  type InterceptedAction,
} from '@bench/core';
import { startInterceptor } from './interceptor.js';

/**
 * The hire path — ARCHITECTURE.md 2.1.
 *
 * An audition *records*; a hire *gates*. Both use the same interceptor, which
 * is the point: the bound a hired agent runs under is derived from the
 * behaviour that same machinery observed, not guessed at by the user in a
 * checkout form.
 *
 * Point the hired agent at `rpcUrl`. A transaction outside its envelope is
 * refused here and never reaches `upstreamRpcUrl` — so in the real
 * deployment, where upstream is a node and the signer is a capped session
 * key, it never reaches a chain at all.
 */

export interface GatedSessionOptions {
  /** The node the agent's approved transactions are forwarded to. */
  readonly upstreamRpcUrl: string;
  /** Derived from this agent's auditions. See `deriveEnvelope`. */
  readonly envelope: BehaviouralEnvelope;
  readonly policy?: EnvelopePolicy;
  readonly onDecision?: (candidate: CandidateAction, decision: GateDecision) => void;
  readonly onAction?: (action: InterceptedAction) => void;
}

export interface GatedSessionHandle {
  /** Give this to the hired agent instead of a node URL. */
  readonly rpcUrl: string;
  /** Every decision, in order — the hire card's blocked-transaction log. */
  readonly decisions: readonly {
    readonly candidate: CandidateAction;
    readonly decision: GateDecision;
  }[];
  readonly blockedCount: () => number;
  close(): Promise<void>;
}

export async function startGatedSession(opts: GatedSessionOptions): Promise<GatedSessionHandle> {
  const decisions: { candidate: CandidateAction; decision: GateDecision }[] = [];

  const interceptor = await startInterceptor({
    upstreamUrl: opts.upstreamRpcUrl,
    onAction: (a) => opts.onAction?.(a),
    gate: (candidate) => checkAgainstEnvelope(candidate, opts.envelope, opts.policy),
    onDecision: (candidate, decision) => {
      decisions.push({ candidate, decision });
      opts.onDecision?.(candidate, decision);
    },
  });

  return {
    rpcUrl: interceptor.url,
    decisions,
    blockedCount: () => interceptor.blockedCount(),
    close: () => interceptor.close(),
  };
}
