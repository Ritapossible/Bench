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

const STEPS = CONSENT_STEPS.map((id) => ({ id, title: STEP_TITLE[id] ?? id, prompt: CONSENT_PROMPTS[id] }));

const VENUS = '0xfd5840cd36d94d7229439859c0112a4185bc0255';
const PCS = '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364';

export default async function HirePage({
  params,
}: {
  readonly params: Promise<{ readonly chain: string; readonly tokenId: string }>;
}) {
  const { chain, tokenId } = await params;
  const agent = await data.getAgent(chain, tokenId);
  if (agent === null) notFound();

  const card = agent.entry.record.card;
  const delta = agent.score ? (agent.score.normalized - 0.5) * 800 : null;
  const category = card?.category ?? 'other';

  const summary =
    agent.score === null
      ? `${card?.name ?? 'This agent'} has no completed auditions. It is listed and probed, but there is no record to hire against - and no bound to derive from one.`
      : `Across ${agent.score.sampleSize} auditions on the same position and window, ${card?.name} came out ${usd(delta ?? 0, { sign: true })} against doing nothing. Every figure is simulated and labelled as such.`;

  return (
    <section className="wrap section">
      <div className="stack stack-32" style={{ maxWidth: '46rem' }}>
        <div className="stack stack-16">
          <Link href={agentHref(chain, BigInt(tokenId))} className="small" style={{ textDecoration: 'none' }}>
            &larr; {card?.name ?? 'Agent'}
          </Link>
          <span className="eyebrow">Hire</span>
          <h1 className="h2">Set the bounds before anything is signed.</h1>
          <p className="lead">
            Five confirmations, in order, and the last one shows all of them together. Nothing moves until the
            final step - and a hired agent is still held to what it did in audition.
          </p>
        </div>

        {agent.score === null ? (
          <div className="card stack stack-12">
            <p className="quote">This agent has no audition record yet.</p>
            <p className="body">
              Bench will not offer a hire without one. There is nothing to rank it on, and nothing to derive a
              behavioural bound from - which would leave the spend cap as the only thing standing between the
              agent and your position.
            </p>
            <div><Link href="/agents" className="btn btn-outline btn-sm">Back to the catalog</Link></div>
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
