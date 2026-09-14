'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { BenchError, disputeTermsFor, type DisputeGround } from '@bench/core';
import { hireStore } from '@/lib/hire/runtime';
import { currentOwner } from '@/lib/hire/owner';
import { arbiter } from '@/lib/dispute/runtime';
import { tryPin } from '@/lib/dispute/pin';

/**
 * Filing a dispute, from the hire page.
 *
 * Every field here is attacker-supplied: a Server Action is a public HTTP
 * endpoint and the form around it is a suggestion. So the same discipline as
 * `createHire` - parse before use, own the hire before touching it, and turn a
 * refusal into a redirect rather than a stack trace.
 *
 * **What this action deliberately does not do is decide anything.** It files.
 * The ruling happens on GenLayer, by validators none of the three parties
 * control, and nothing in this file can influence it - which is the whole
 * reason the dispute layer exists rather than a "report this agent" button that
 * ends in Bench's inbox.
 */

const GROUNDS = ['breach', 'delivery'] as const;

const disputeForm = z.object({
  hireId: z.string().min(1).max(128),
  ground: z.enum(GROUNDS),
  /**
   * What the agent was hired to do, in the hirer's own words.
   *
   * Bounded at 2,000 because it is quoted into a model prompt on the delivery
   * ground, and an unbounded field there is an unbounded bill - fenced, but
   * still paid for by the token.
   */
  engagement: z.string().min(1).max(2_000),
  /** One per line. Numbered by the contract; these are what it rules on. */
  criteria: z.string().min(1).max(4_000),
  /** One per line. https only; the contract refuses anything else outright. */
  evidenceUrls: z.string().max(4_000).default(''),
  /**
   * The filing bond, in GEN.
   *
   * Returns on `upheld` and on `abstained`; goes to the agent on `dismissed`.
   * Bounded above for the same reason every cap in `createHire` is: a number
   * somebody could not plausibly have meant is more likely a mistake than an
   * intention, and this one moves real value.
   */
  bondGen: z.coerce.number().finite().positive().max(1_000).default(0.01),
});

const lines = (raw: string, limit: number): string[] =>
  raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(0, limit);

function formObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of disputeForm.keyof().options) {
    const v = form.get(key);
    if (typeof v === 'string' && v !== '') out[key] = v;
  }
  return out;
}

/**
 * Where a failure sends the reader, with a code the page turns into a sentence.
 *
 * Annotated on the variable, not just the arrow. TypeScript only narrows past a
 * never-returning call when the *binding* carries the type, so without it every
 * use of `input` after an early exit is "possibly undefined" - and the fix
 * someone reaches for is a non-null assertion, which would silence the checker
 * on exactly the path where the parse failed.
 */
const back: (hireId: string, code: string) => never = (hireId, code) =>
  redirect(`/hires/${encodeURIComponent(hireId)}?dispute=${code}`);

export async function openDispute(form: FormData): Promise<void> {
  const owner = await currentOwner();
  const parsed = disputeForm.safeParse(formObject(form));
  if (!parsed.success) {
    const id = String(form.get('hireId') ?? '');
    if (id === '') redirect('/hires');
    back(id, 'malformed');
  }
  const input = parsed.data;

  /**
   * Ownership first, before anything reaches the chain.
   *
   * The contract checks this too - only the registered client may open a
   * dispute - but a filing is payable, and letting a stranger's submission get
   * as far as a transaction means spending the deployment's GEN to be told no.
   */
  const hire = await hireStore().get(input.hireId);
  if (hire === null || hire.owner.toLowerCase() !== owner.toLowerCase()) {
    redirect('/hires');
  }

  if (!arbiter.available) back(input.hireId, 'unavailable');

  const criteria = lines(input.criteria, 8);
  if (criteria.length === 0) back(input.hireId, 'malformed');

  try {
    await arbiter.openDispute({
      hireId: input.hireId,
      ground: input.ground as DisputeGround,
      engagement: input.engagement,
      criteria,
      evidenceUrls: lines(input.evidenceUrls, 3),
      // GEN has 18 decimals. Via milli-units so a value a person typed does not
      // arrive as a floating-point artefact.
      bond: BigInt(Math.round(input.bondGen * 1_000)) * 10n ** 15n,
    });
  } catch (err) {
    if (err instanceof BenchError) {
      // The contract's own refusals are the useful ones - a bond below the
      // floor, a hire nobody registered, an id that is not the caller's. They
      // reach the page as a code rather than a 500.
      back(input.hireId, 'refused');
    }
    throw err;
  }

  revalidatePath(`/hires/${input.hireId}`);
  back(input.hireId, 'filed');
}

/**
 * There is deliberately no `answerDispute` action here.
 *
 * The respondent is the agent's operator, not the person holding this browser
 * session - and the session's owner is the *claimant*. An action on this
 * surface could only ever be the claimant answering its own dispute, which is
 * the one thing it must not do. The contract refuses it as well
 * (`screen_answer` admits only the respondent), but a form that reaches a chain
 * to be told no is a form that should not have been offered.
 *
 * The hire page says who may answer and by when instead. When there is an
 * operator-facing surface, the action belongs there.
 */

/**
 * Pin a hire's terms on the arbiter.
 *
 * **Separate from opening a dispute, and that separation is the point.** If the
 * terms arrived with the complaint, the complaining party would be stating the
 * rules they were owed, and the only available check would be whether the other
 * side agreed - which is the argument the dispute exists because the parties
 * cannot have. Registered up front, they are a fact about the past.
 *
 * Attempted automatically when a hire is created. This is the retry, for the
 * deployment whose GenLayer key ran dry, or whose first attempt hit a chain
 * that was not answering. It is not a second chance to choose the terms: they
 * are computed from the stored hire by `disputeTermsFor`, the same function the
 * adjudication will hash, and the contract refuses a second registration of a
 * hire it already holds.
 */
export async function pinHireTerms(form: FormData): Promise<void> {
  const owner = await currentOwner();
  const hireId = String(form.get('hireId') ?? '');
  if (hireId === '') redirect('/hires');

  const hire = await hireStore().get(hireId);
  if (hire === null || hire.owner.toLowerCase() !== owner.toLowerCase()) redirect('/hires');
  if (!arbiter.available) back(hireId, 'unavailable');

  const outcome = await tryPin(hire);
  revalidatePath(`/hires/${hireId}`);
  back(hireId, outcome);
}

/**
 * Rule on a dispute whose answer window has closed.
 *
 * **Permissionless on the contract, and deliberately not gated here either.**
 * Restricting adjudication to the claimant would create a collusion path - the
 * respondent pays privately not to adjudicate, the window lapses, and the
 * dispute was theatre. This action only needs someone to press the button; the
 * ruling is computed by validators none of the three parties control, and
 * nothing in this file influences it.
 *
 * The terms are rebuilt from the stored hire rather than taken from the form,
 * because the contract hashes them against the digest pinned at registration.
 * A caller who supplies different terms is refused by the hash, not trusted -
 * but there is no reason to make the hirer's own browser the one that tries.
 */
export async function adjudicateDispute(form: FormData): Promise<void> {
  const owner = await currentOwner();
  const hireId = String(form.get('hireId') ?? '');
  const disputeId = Number(form.get('disputeId'));
  if (hireId === '' || !Number.isInteger(disputeId) || disputeId < 0) redirect('/hires');

  const hire = await hireStore().get(hireId);
  if (hire === null || hire.owner.toLowerCase() !== owner.toLowerCase()) redirect('/hires');
  if (!arbiter.available) back(hireId, 'unavailable');

  try {
    await arbiter.adjudicate(disputeId, disputeTermsFor(hire));
  } catch (err) {
    if (err instanceof BenchError) {
      // The contract's refusals are the useful ones here: the answer window is
      // still open, the dispute is already settled, or the terms do not match
      // the digest. They reach the page as a code rather than a 500.
      back(hireId, 'not-ruled');
    }
    throw err;
  }

  revalidatePath(`/hires/${hireId}`);
  back(hireId, 'ruled');
}
