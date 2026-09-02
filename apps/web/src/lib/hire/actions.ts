'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { deriveEnvelope, type Address, type ConsentStep } from '@bench/core';
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
  const chain = String(form.get('chain'));
  const tokenId = String(form.get('tokenId'));
  const agent = await data.getAgent(chain, tokenId);
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

  const allowlist = String(form.get('allowlist') ?? '')
    .split(/[\s,]+/)
    .filter((a) => /^0x[a-fA-F0-9]{40}$/.test(a)) as Address[];

  const record = await hireOrchestrator().hire({
    // Namespaced by owner: a client-supplied key is only trusted within the
    // browser that supplied it, so a guessed key cannot reach another owner's
    // hire - `hire()` returns the winning record on a lost claim, which made a
    // shared key namespace a way to read someone else's mandate and trace.
    idempotencyKey: `${owner}:${String(form.get('idempotencyKey')).slice(0, 128)}`,
    owner,
    agent: agent.entry.record.id,
    bounds: {
      totalSpendCap: usdt(Number(form.get('totalCap') ?? 50)),
      perTxCap: usdt(Number(form.get('perTxCap') ?? 10)),
      contractAllowlist: allowlist,
      expiresAt: new Date(Date.now() + Number(form.get('expiryHours') ?? 24) * 3_600_000),
      maxActions: Number(form.get('maxActions') ?? 20),
    },
    consent: form.getAll('consent').map(String) as ConsentStep[],
    taskSpec: String(form.get('taskSpec') ?? '').slice(0, 500),
    price: usdt(Number(form.get('price') ?? 5)),
    payTo: owner,
    disputeWindowSec: 3_600,
    envelope: deriveEnvelope(runs),
  });

  revalidatePath('/hires');
  redirect(`/hires/${record.id}`);
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
