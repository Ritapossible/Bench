import type { AgentId } from '../types/agent.js';
import type { Bps } from '../types/primitives.js';

/**
 * Independent cross-reference of what Bench indexed.
 *
 * The main track scores **Data Quality** — *"real-time, accurate data that
 * goes beyond basic counts"*. A count from one source is an assertion; the
 * same count corroborated by a second, independent source is evidence, and
 * the *disagreements* are the interesting part. This port exists to produce
 * that comparison.
 *
 * The governing rule, and the reason every method returns a status rather than
 * throwing: **a cross-reference may never gate the catalog.** The chain is the
 * source of truth. If the source is unconfigured, rate-limited, down, or
 * returns something unrecognisable, Bench shows its own data and says the
 * corroboration is unavailable. It enriches; it never blocks.
 */

export type CrossReferenceStatus =
  /** Compared successfully. */
  | 'ok'
  /** No API key configured. The normal state until one is granted. */
  | 'unconfigured'
  /** Configured, but the source failed, rate-limited, or answered unrecognisably. */
  | 'unavailable';

export interface CrossReferenceRecord {
  readonly agent: AgentId;
  /** Does the external source also know this agent exists? */
  readonly knownToSource: boolean;
  /** Endpoints the source lists, when it says. Null when it does not. */
  readonly endpointCount: number | null;
  /** Deep link, so the UI can credit the source and let a user check. */
  readonly sourceUrl: string | null;
}

export interface CrossReferenceResult {
  readonly source: string;
  readonly status: CrossReferenceStatus;
  readonly records: readonly CrossReferenceRecord[];
  readonly checkedAt: Date;
  /** Why, when the status is not `ok`. Shown rather than swallowed. */
  readonly note?: string;
}

export interface CrossReferenceSource {
  readonly name: string;
  /** Never throws. Failure is a status, because failure is expected. */
  lookup(agents: readonly AgentId[]): Promise<CrossReferenceResult>;
}

/**
 * The publishable number: of the agents Bench indexed from chain, how many does
 * an independent explorer also see?
 *
 * Deliberately one-directional and labelled as such. Looking agents up by the
 * ids Bench already holds cannot discover agents the source knows and Bench
 * does not, so this measures *corroboration*, not *coverage*, and the type
 * does not pretend otherwise.
 */
export interface AgreementSummary {
  readonly source: string;
  readonly status: CrossReferenceStatus;
  readonly checked: number;
  readonly confirmed: number;
  readonly notFound: number;
  readonly agreementBps: Bps;
}

export function summarizeAgreement(result: CrossReferenceResult): AgreementSummary {
  const checked = result.records.length;
  const confirmed = result.records.filter((r) => r.knownToSource).length;
  return {
    source: result.source,
    status: result.status,
    checked,
    confirmed,
    notFound: checked - confirmed,
    agreementBps: checked === 0 ? 0 : Math.round((confirmed / checked) * 10_000),
  };
}

/** Used whenever no source is configured. Keeps callers free of null checks. */
export const nullCrossReference = (name = 'none'): CrossReferenceSource => ({
  name,
  async lookup(): Promise<CrossReferenceResult> {
    return {
      source: name,
      status: 'unconfigured',
      records: [],
      checkedAt: new Date(),
      note: 'no cross-reference source is configured',
    };
  },
});
