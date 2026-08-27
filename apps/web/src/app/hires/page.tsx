import Link from 'next/link';
import { DEMO_OWNER, hireStore } from '@/lib/hire/runtime';
import { remaining } from '@bench/core';

export const metadata = { title: 'Your hires - Bench' };
export const dynamic = 'force-dynamic';

const STATE_BADGE: Record<string, string> = {
  active: 'badge badge-live',
  settled: 'badge badge-plain',
  revoked: 'badge badge-blocked',
  failed: 'badge badge-blocked',
};

export default async function HiresPage() {
  const hires = await hireStore().listByOwner(DEMO_OWNER);

  return (
    <section className="wrap section">
      <div className="stack stack-32">
        <div className="stack stack-16" style={{ maxWidth: '44rem' }}>
          <span className="eyebrow">Active hires</span>
          <h1 className="h2">What you have authorised, and what is left of it.</h1>
          <p className="lead">
            Every hire carries the bounds you set, the headroom remaining, and a decision trace that
            cannot be edited after the fact. Revoke is available from any live state.
          </p>
        </div>

        {hires.length === 0 ? (
          <div className="card stack stack-12">
            <p className="body">No hires yet.</p>
            <div>
              <Link href="/agents" className="btn btn-primary btn-sm">
                Browse the catalog
              </Link>
            </div>
            <p className="tiny">
              Hires on this deployment live in memory, so a cold start clears them. `@bench/db`
              implements the same store interface against Postgres.
            </p>
          </div>
        ) : (
          <div className="stack stack-12">
            {[...hires].reverse().map((h) => {
              const left = remaining(h.mandate, h.mandateState);
              return (
                <Link key={h.id} href={`/hires/${h.id}`} className="card card-link">
                  <div className="sumcard">
                    <div className="sumcard-head">
                      <h2 className="h4">Agent #{h.agent.tokenId.toString()}</h2>
                      <span className={STATE_BADGE[h.state] ?? 'badge badge-plain'}>{h.state}</span>
                    </div>
                    <div className="sumcard-score">
                      <span className="mono ink" style={{ fontWeight: 700 }}>
                        {(Number(left.spend) / 1e18).toFixed(2)} USDT
                      </span>
                      <span className="tiny">of cap remaining</span>
                    </div>
                    <div className="sumcard-body">
                      <p className="tiny mono break">{h.id}</p>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
