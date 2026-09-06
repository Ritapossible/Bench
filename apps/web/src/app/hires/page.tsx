import Link from 'next/link';
import { hireStore, hiresAreDurable } from '@/lib/hire/runtime';
import { currentOwnerReadOnly } from '@/lib/hire/owner';
import { isStalled, remaining } from '@bench/core';

export const metadata = { title: 'Your hires - Bench' };
export const dynamic = 'force-dynamic';

const STATE_BADGE: Record<string, string> = {
  active: 'badge badge-live',
  settled: 'badge badge-plain',
  revoked: 'badge badge-blocked',
  failed: 'badge badge-blocked',
};

export default async function HiresPage() {
  // Null until this browser has hired: an empty list is the truth, not an error.
  const owner = await currentOwnerReadOnly();
  const hires = owner === null ? [] : await hireStore().listByOwner(owner);
  // Said, not assumed. This was exported as "surfaced in the UI" and read by
  // nothing, so a deployment holding hires in memory looked identical to one
  // that persists them right up until a restart lost them.
  const durable = hiresAreDurable();

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
          {durable ? null : (
            <p className="notice notice-warn" role="status">
              This deployment has no database configured, so hires are held in memory and will be
              lost when the server restarts.
            </p>
          )}
        </div>

        {hires.length === 0 ? (
          <div className="card stack stack-12">
            <p className="body">No hires yet.</p>
            <div>
              <Link href="/agents" className="btn btn-primary btn-sm">
                Browse the catalog
              </Link>
            </div>
            {/* Read from the runtime, not asserted.
                This line was hardcoded to the in-memory case and stayed that
                way after the Postgres store was wired, so a deployment with a
                database was telling every reader that its hires evaporate on
                restart - on the one page whose job is to show that an
                authorisation persists and can be revoked. A deployment that
                understates itself is still a deployment saying something
                untrue about what it does. */}
            <p className="tiny">
              {hiresAreDurable()
                ? 'Hires are stored in Postgres: they survive restarts, and the bounds you set stay enforceable until they expire or you revoke them.'
                : 'No database is configured on this deployment, so hires live in memory and a cold start clears them. `@bench/db` implements the same store interface against Postgres.'}
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
                      {/* A hire moves through its opening states inside one
                          request, so one still mid-flight minutes later means
                          the process died partway. Nothing retries it, so the
                          honest thing is to say so rather than show a state
                          that reads as work in progress. */}
                      {isStalled(h.state, h.createdAt) ? (
                        <span className="badge badge-dead">did not finish</span>
                      ) : null}
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
