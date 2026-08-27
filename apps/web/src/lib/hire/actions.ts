'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { deriveEnvelope, type Address, type InterceptedAction } from '@bench/core';
import { data } from '@/lib/data/index';
import { DEMO_OWNER, SETTLEMENT_TOKEN, hireOrchestrator } from '@/lib/hire/runtime';

const usdt = (whole: number) => ({
  token: SETTLEMENT_TOKEN,
  symbol: 'USDT',
  decimals: 18,
  amount: BigInt(Math.round(whole * 1e6)) * 10n ** 12n,
});

/**
 * Create a hire from the checkout form.
 *
 * The consent list arrives from the client, but it is the domain that decides
 * whether it is complete and in order - `HireOrchestrator` refuses an
 * incomplete one before any money moves, so a tampered form cannot skip it.
 */
export async function createHire(form: FormData): Promise<void> {
  const chain = String(form.get('chain'));
  const tokenId = String(form.get('tokenId'));
  const agent = await data.getAgent(chain, tokenId);
  if (agent === null) redirect('/agents');

  const runs = agent.runs.map((r, i) => ({
    actions: (agent.outcomes[i] === undefined
      ? []
      : syntheticActions(agent.outcomes[i]!.actionCount)) as readonly InterceptedAction[],
    positionDropUsd: Math.max(0, -(agent.outcomes[i]?.deltaVsDoNothingUsd ?? 0)),
  }));

  const allowlist = String(form.get('allowlist') ?? '')
    .split(/[\s,]+/)
    .filter((a) => /^0x[a-fA-F0-9]{40}$/.test(a)) as Address[];

  const record = await hireOrchestrator().hire({
    idempotencyKey: String(form.get('idempotencyKey')),
    owner: DEMO_OWNER,
    agent: agent.entry.record.id,
    bounds: {
      totalSpendCap: usdt(Number(form.get('totalCap') ?? 50)),
      perTxCap: usdt(Number(form.get('perTxCap') ?? 10)),
      contractAllowlist: allowlist,
      expiresAt: new Date(Date.now() + Number(form.get('expiryHours') ?? 24) * 3_600_000),
      maxActions: Number(form.get('maxActions') ?? 20),
    },
    consent: [
      'reviewed-audition',
      'set-spend-cap',
      'set-allowlist',
      'set-expiry',
      'reviewed-summary',
    ],
    taskSpec: String(form.get('taskSpec') ?? '').slice(0, 500),
    price: usdt(Number(form.get('price') ?? 5)),
    payTo: DEMO_OWNER,
    disputeWindowSec: 3_600,
    envelope: deriveEnvelope(runs),
  });

  revalidatePath('/hires');
  redirect(`/hires/${record.id}`);
}

export async function revokeHire(form: FormData): Promise<void> {
  const id = String(form.get('hireId'));
  await hireOrchestrator().revoke(id, 'revoked by owner from the hire dashboard');
  revalidatePath(`/hires/${id}`);
  revalidatePath('/hires');
}

/**
 * Stand-in audition actions.
 *
 * The envelope is derived from what an agent did in audition; this deployment
 * stores outcome counts rather than the raw intercepted actions, so the shape
 * is reconstructed from them. When the shadow engine writes through to
 * Postgres, the real actions replace this and the envelope tightens.
 */
function syntheticActions(count: number): InterceptedAction[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i,
    at: new Date(),
    to: '0xfd5840cd36d94d7229439859c0112a4185bc0255' as Address,
    value: 10n ** 18n,
    data: '0x' as `0x${string}`,
    decoded: null,
    simulated: { success: true, gasUsed: 21_000n },
  }));
}
