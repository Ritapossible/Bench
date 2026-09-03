import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CONSENT_PROMPTS, CONSENT_STEPS } from '@bench/core';
import { data } from '@/lib/data/index';
import { HireCheckout } from '@/components/HireCheckout';
import { CATEGORY_LABEL, usd, agentHref } from '@/lib/format';

export const metadata = { title: 'Hire - Bench' };

/** One definition, read on the server and handed to the client as plain data. */
const STEP_TITLE: Record<string, string> = {
  'reviewed-audition': 'Review the record',
  'set-spend-cap': 'Set the ceilings',
  'set-allowlist': 'Choose what it may touch',
  'set-expiry': 'Choose when it ends',
  'reviewed-summary': 'Confirm, together',
};

const STEPS = CONSENT_STEPS.map((id) => ({
  id,
  title: STEP_TITLE[id] ?? id,
  prompt: CONSENT_PROMPTS[id],
}));

const VENUS = '0xfd5840cd36d94d7229439859c0112a4185bc0255';
const PCS = '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364';

/**
 * What a refused hire is told.
 *
 * A refusal the domain makes on purpose used to escape the Server Action and
 * render as a 500 with a stack trace, which tells a user who missed a checkbox
 * nothing they can act on.
 */
const REFUSAL: Record<string, string> = {
  INVALID_REQUEST:
    'Every bound has to be confirmed before a hire is created. Work down the list below - the last step only unlocks once the others are ticked.',
  SPEND_CAP_EXCEEDED:
    'That ceiling is outside what this deployment allows. Lower it and try again.',
  SESSION_KEY_REVOKED: 'The session key backing this hire has been revoked. Start a new hire.',
  NOT_FOUND: 'That agent is no longer in the catalog.',
};

export default async function HirePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly chain: string; readonly tokenId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { chain, tokenId } = await params;
  const errorCode = (await searchParams)['error'];
  const refusal =
    typeof errorCode === 'string'
      ? (REFUSAL[errorCode] ?? 'That hire was refused. Check the bounds below and try again.')
      : null;
  const agent = await data.getAgent(chain, tokenId);
  if (agent === null) notFound();

  const card = agent.entry.record.card;
  const delta = agent.score?.meanDeltaUsd ?? null;
  const category = card?.category ?? 'other';

  const summary =
    agent.score === null
      ? `${card?.name ?? 'This agent'} has no completed auditions. It is listed and probed, but there is no record to hire against - and no bound to derive from one.`
      : `Across ${agent.score.sampleSize} auditions on the same position and window, ${card?.name} came out ${usd(delta ?? 0, { sign: true })} against doing nothing. Every figure is measured from a run against forked mainnet state, not estimated.`;

  return (
    <section className="wrap section">
      <div className="stack stack-32" style={{ maxWidth: '46rem' }}>
        <div className="stack stack-16">
          <Link
            href={agentHref(chain, BigInt(tokenId))}
            className="small"
            style={{ textDecoration: 'none' }}
          >
            &larr; {card?.name ?? 'Agent'}
          </Link>
          <span className="eyebrow">Hire</span>
          <h1 className="h2">Set the bounds before anything is signed.</h1>
          {refusal === null ? null : (
            <p className="notice notice-warn" role="alert">
              {refusal}
            </p>
          )}
          <p className="lead">
            Five confirmations, in order, and the last one shows all of them together. Nothing moves
            until the final step - and a hired agent is still held to what it did in audition.
          </p>
        </div>

        {agent.score === null ? (
          <div className="card stack stack-12">
            <p className="quote">This agent has no audition record yet.</p>
            <p className="body">
              Bench will not offer a hire without one. There is nothing to rank it on, and nothing
              to derive a behavioural bound from - which would leave the spend cap as the only thing
              standing between the agent and your position.
            </p>
            <div>
              <Link href="/agents" className="btn btn-outline btn-sm">
                Back to the catalog
              </Link>
            </div>
          </div>
        ) : (
          <HireCheckout
            chain={chain}
            tokenId={tokenId}
            agentName={card?.name ?? `Agent #${tokenId}`}
            category={CATEGORY_LABEL[category] ?? category}
            auditionSummary={summary}
            suggestedAllowlist={category === 'health-factor' ? [VENUS] : [PCS]}
            price={5}
            steps={STEPS}
          />
        )}
      </div>
    </section>
  );
}
