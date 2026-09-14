/**
 * Registering a hire's terms with the arbiter.
 *
 * **Deliberately not in `actions.ts`.** That file carries `'use server'`, which
 * makes every export a public HTTP endpoint reachable by anyone who can guess
 * an action id - and `tryPin` takes a whole `HireRecord`. Exported from there it
 * would let a stranger hand Bench a record they wrote themselves and have
 * Bench's own key register it on the arbiter, naming whatever client,
 * respondent and terms they liked. The server action that does this
 * (`pinHireTerms`) takes a hire *id*, checks ownership, and loads the record
 * from storage; this module is the part neither caller may supply.
 */
import { disputeTermsFor, type HireRecord } from '@bench/core';
import { data } from '@/lib/data/index';
import { arbiter } from '@/lib/dispute/runtime';

/**
 * Where the action record for a hire is published.
 *
 * Absolute, because the arbiter's validators fetch it from outside this
 * process, and pinned into the registration before anyone knows there will be a
 * dispute - so the claimant cannot choose a flattering source after the fact.
 */
const recordUrl = (hireId: string): string => {
  const base = (process.env['BENCH_PUBLIC_WEB_URL'] ?? 'https://bench-bnb.vercel.app').replace(
    /\/+$/,
    '',
  );
  return `${base}/api/hires/${encodeURIComponent(hireId)}/actions`;
};

/**
 * The registration itself, shared by the automatic attempt and the manual one.
 *
 * Returns a code rather than throwing, because both callers want to carry on: a
 * hire whose terms did not pin is still a hire, and failing the whole creation
 * over a second chain being slow would be the wrong trade by a wide margin.
 */
export async function tryPin(hire: HireRecord): Promise<'pinned' | 'pin-failed' | 'unavailable'> {
  if (!arbiter.available) return 'unavailable';
  const agent = await data.getAgent(hire.agent.chain, hire.agent.tokenId.toString());
  if (agent === null) return 'pin-failed';

  const respondent = agent.entry.record.owner;
  const host = endpointHost(agent.entry.record.card?.endpoints[0]?.url);
  if (respondent.toLowerCase() === hire.owner.toLowerCase()) {
    // The contract refuses a hire whose two sides are one address, because
    // every window and every bond would be meaningless. Caught here so the
    // refusal does not cost a transaction.
    return 'pin-failed';
  }

  try {
    await arbiter.registerHire({
      hireId: hire.id,
      agent: hire.agent,
      client: hire.owner,
      respondent,
      terms: disputeTermsFor(hire),
      recordUrl: recordUrl(hire.id),
      // The agent's own host, so evidence published there is classified as the
      // respondent's rather than as independent. An agent that publishes its own
      // account of a hire should count for something, and it should not count as
      // a disinterested source.
      ...(host === null ? {} : { respondentDomain: host }),
    });
    return 'pinned';
  } catch {
    // Every reason to land here is a reason to carry on: no funded GenLayer
    // key, a chain that is not answering, or a hire the arbiter already holds.
    // The hire page reports the unpinned state and offers the retry.
    return 'pin-failed';
  }
}

const endpointHost = (endpoint: string | null | undefined): string | null => {
  if (endpoint === null || endpoint === undefined || endpoint === '') return null;
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null;
  }
};
