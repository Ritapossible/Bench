'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { BenchError, deriveEnvelope, type Address, type ConsentStep } from '@bench/core';
import { data } from '@/lib/data/index';
import { SETTLEMENT_TOKEN, hireOrchestrator, hireStore } from '@/lib/hire/runtime';
import { currentOwner } from '@/lib/hire/owner';

const usdt = (whole: number) => ({
  token: SETTLEMENT_TOKEN,
  symbol: 'USDT',
  decimals: 18,
  amount: BigInt(Math.round(whole * 1e6)) * 10n ** 12n,
});

/**
 * The form, validated.
 *
 * A Server Action is a public HTTP endpoint, and every numeric field here used
 * to reach `Number()` unchecked. `Number('abc')` is NaN, and `BigInt(NaN)`
 * throws a RangeError, so a hand-rolled POST returned a 500; a negative value
 * passed straight through to become a negative spend cap, which is a bound that
 * cannot be exceeded because it was never a bound.
 *
 * Bounded above as well as below. A cap is a safety limit, and one large enough
 * to overflow the display or to mean nothing in practice is not one - so the
 * numbers are held inside ranges a person could plausibly have meant.
 */
const hireForm = z.object({
  chain: z.string().min(1).max(32),
  tokenId: z.string().regex(/^\d{1,78}$/, 'token id must be a number'),
  idempotencyKey: z.string().min(1).max(128),
  totalCap: z.coerce.number().finite().positive().max(1_000_000).default(50),
  perTxCap: z.coerce.number().finite().positive().max(1_000_000).default(10),
  price: z.coerce.number().finite().nonnegative().max(1_000_000).default(5),
  expiryHours: z.coerce
    .number()
    .finite()
    .positive()
    .max(24 * 365)
    .default(24),
  maxActions: z.coerce.number().int().positive().max(10_000).default(20),
  taskSpec: z.string().max(500).default(''),
  allowlist: z.string().max(4_096).default(''),
});

/**
 * `formData.get` returns null for an absent field, and `z.coerce.number()`
 * turns null into 0 rather than letting the default apply - so absent fields
 * are dropped before parsing instead of being passed as null.
 */
function formObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of hireForm.keyof().options) {
    const v = form.get(key);
    if (typeof v === 'string' && v !== '') out[key] = v;
  }
  return out;
}

/**
 * Create a hire from the checkout form.
 *
 * The consent list arrives from the client and is passed through unchanged, so
 * the domain decides whether it is complete and in order - `HireOrchestrator`
 * refuses an incomplete one before any money moves, and a tampered form is
 * refused for the same reason rather than a different one.
 *
 * Passing it through matters more than it looks. This action previously built
 * the list itself, always complete, which meant `consentComplete` could not
 * fail and the ordered checklist was decorative: a user who skipped every
 * confirmation got the same hire as one who read all five.
 */
export async function createHire(form: FormData): Promise<void> {
  const owner = await currentOwner();

  const parsed = hireForm.safeParse(formObject(form));
  if (!parsed.success) {
    // A malformed submission is a bad request, not a server fault. Returning to
    // the catalog is the same outcome as an unknown agent below, and says as
    // little to someone probing the endpoint.
    redirect('/agents');
  }
  const input = parsed.data;

  const agent = await data.getAgent(input.chain, input.tokenId);
  if (agent === null) redirect('/agents');

  /**
   * The envelope's input: what this agent actually did, per audition.
   *
   * Previously these actions were invented from an outcome's action count -
   * same recipient, same selector, same value for every agent in the catalog -
   * so `deriveEnvelope` returned a bound that described no agent at all while
   * the UI presented it as the agent's own behaviour. Runs with no recorded
   * actions contribute an empty list rather than a fabricated one, which is
   * what makes the envelope thin and the gate advisory: correct, and visible.
   */
  const byRun = new Map(agent.outcomes.map((o) => [o.runId, o]));
  const runs = agent.runs.map((r) => ({
    actions: agent.actionsByRun.get(r.id) ?? [],
    positionDropUsd: Math.max(0, -(byRun.get(r.id)?.deltaVsDoNothingUsd ?? 0)),
  }));

  const allowlist = input.allowlist
    .split(/[\s,]+/)
    .filter((a) => /^0x[a-fA-F0-9]{40}$/.test(a)) as Address[];

  const attempt = await tryHire({
    // Namespaced by owner: a client-supplied key is only trusted within the
    // browser that supplied it, so a guessed key cannot reach another owner's
    // hire - `hire()` returns the winning record on a lost claim, which made a
    // shared key namespace a way to read someone else's mandate and trace.
    idempotencyKey: `${owner}:${input.idempotencyKey}`,
    owner,
    agent: agent.entry.record.id,
    bounds: {
      totalSpendCap: usdt(input.totalCap),
      perTxCap: usdt(input.perTxCap),
      contractAllowlist: allowlist,
      expiresAt: new Date(Date.now() + input.expiryHours * 3_600_000),
      maxActions: input.maxActions,
    },
    consent: form.getAll('consent').map(String) as ConsentStep[],
    taskSpec: input.taskSpec,
    price: usdt(input.price),
    /**
     * The agent's operator - the ERC-8004 identity NFT holder - not the hirer.
     *
     * This was `owner`, so every hire paid the person making it. Inert while
     * payment is simulated, and wrong in two ways that would not have stayed
     * inert: the settlement adapter would send funds to the wrong address the
     * day it becomes real, and `spentAgainst` keys cumulative spend by payee,
     * so a hirer's separate hires of different agents all metered against one
     * bucket.
     */
    payTo: agent.entry.record.owner,
    disputeWindowSec: 3_600,
    envelope: deriveEnvelope(runs),
  });

  // `redirect` throws a control-flow signal that a catch would swallow, so both
  // outcomes are decided first and redirected to afterwards.
  if (attempt.ok === false) {
    redirect(`/agents/${input.chain}/${input.tokenId}/hire?error=${attempt.code}`);
  }

  revalidatePath('/hires');
  redirect(`/hires/${attempt.record.id}`);
}

export async function revokeHire(form: FormData): Promise<void> {
  const owner = await currentOwner();
  const id = String(form.get('hireId'));

  // Ownership check before the state change. Without it this action revoked any
  // hire whose id was known or guessed, from any browser.
  const existing = await hireStore().get(id);
  if (existing === null || existing.owner.toLowerCase() !== owner.toLowerCase()) {
    redirect('/hires');
  }

  await hireOrchestrator().revoke(id, 'revoked by owner from the hire dashboard');
  revalidatePath(`/hires/${id}`);
  revalidatePath('/hires');
}

/**
 * Run the hire, turning a domain refusal into a value.
 *
 * Without this an incomplete consent list - which the domain refuses on
 * purpose, and which the checkout can produce - left `BenchError` to escape the
 * Server Action, and Next rendered a 500 with a stack trace. A refusal the
 * product makes deliberately should not reach the user as a server fault, and a
 * user who is told "something went wrong" cannot fix a checkbox they missed.
 */
async function tryHire(
  req: Parameters<ReturnType<typeof hireOrchestrator>['hire']>[0],
): Promise<
  | { ok: true; record: Awaited<ReturnType<ReturnType<typeof hireOrchestrator>['hire']>> }
  | { ok: false; code: string }
> {
  try {
    return { ok: true, record: await hireOrchestrator().hire(req) };
  } catch (err) {
    if (err instanceof BenchError) return { ok: false, code: err.code };
    // Not a refusal: a genuine fault, which belongs in the logs and in a 500.
    throw err;
  }
}

/**
 * The action a hired agent proposes, put through the gate.
 *
 * This exists because the gate had no caller. `authorizeAction` composes the
 * mandate and the behavioural envelope, records the verdict in the hire's hash
 * chain, and was reachable only from tests and a demo script - so a hire stored
 * a mandate that nothing ever checked, while the site said every transaction is
 * checked against the envelope before it is signed. The bound was a document,
 * not a control.
 *
 * The submitted action is a *proposal*, and nothing here signs or broadcasts
 * it: this deployment has no wallet (see `runtime.ts`). What is real is the
 * decision - both bounds evaluated against the agent's own audition behaviour
 * and against spending this hire has already done, appended to a trace whose
 * hash chain makes a later rewrite detectable.
 */
const proposalForm = z.object({
  hireId: z.string().min(1).max(128),
  to: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x address'),
  // Whole tokens in the form; wei is not a unit anyone types correctly.
  valueEth: z.coerce.number().finite().nonnegative().max(1_000_000).default(0),
  data: z
    .string()
    .trim()
    .regex(/^0x([a-fA-F0-9]{2})*$/, 'must be 0x-prefixed hex')
    .max(8_192)
    .default('0x'),
});

export async function proposeAction(form: FormData): Promise<void> {
  const owner = await currentOwner();

  const parsed = proposalForm.safeParse({
    hireId: form.get('hireId'),
    to: form.get('to') ?? '',
    valueEth: form.get('valueEth') ?? 0,
    data: form.get('data') === null || form.get('data') === '' ? '0x' : form.get('data'),
  });
  if (!parsed.success) {
    const id = String(form.get('hireId') ?? '');
    redirect(`/hires/${encodeURIComponent(id)}?error=malformed-action`);
  }
  const input = parsed.data;

  // Ownership before the state change, as everywhere else: authorizeAction
  // appends to the trace and advances mandate state, so an unchecked id would
  // let anyone spend down someone else's mandate.
  const existing = await hireStore().get(input.hireId);
  if (existing === null || existing.owner.toLowerCase() !== owner.toLowerCase()) {
    redirect('/hires');
  }

  const decision = await tryDecide(input.hireId, {
    to: input.to as Address,
    value: BigInt(Math.round(input.valueEth * 1e9)) * 10n ** 9n,
    data: input.data as `0x${string}`,
    token: SETTLEMENT_TOKEN,
  });

  revalidatePath(`/hires/${input.hireId}`);
  redirect(
    decision === null
      ? `/hires/${input.hireId}?error=action-failed`
      : `/hires/${input.hireId}?decided=${decision.allowed ? 'allowed' : 'blocked'}`,
  );
}

/** Same shape as `tryHire`: a refusal is a value, a fault still throws. */
async function tryDecide(
  hireId: string,
  candidate: Parameters<ReturnType<typeof hireOrchestrator>['authorizeAction']>[1],
): Promise<Awaited<ReturnType<ReturnType<typeof hireOrchestrator>['authorizeAction']>> | null> {
  try {
    return await hireOrchestrator().authorizeAction(hireId, candidate);
  } catch (err) {
    if (err instanceof BenchError) return null;
    throw err;
  }
}
