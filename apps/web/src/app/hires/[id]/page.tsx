import Link from 'next/link';
import { remaining, verifyTrace } from '@bench/core';
import { hireStore } from '@/lib/hire/runtime';
import { currentOwnerReadOnly } from '@/lib/hire/owner';
import { revokeHire } from '@/lib/hire/actions';

export const metadata = { title: 'Hire - Bench' };
export const dynamic = 'force-dynamic';

const tokens = (n: bigint) => `${(Number(n) / 1e18).toFixed(2)} USDT`;

export default async function HireDetail({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  // Scoped to the owner. This page used to serve any hire - and its mandate,
  // bounds and full decision trace - to anyone who had the id.
  const owner = await currentOwnerReadOnly();
  const found = await hireStore().get(id);
  const hire =
    found !== null && owner !== null && found.owner.toLowerCase() === owner.toLowerCase()
      ? found
      : null;

  if (hire === null) {
    // One message for "no such hire" and for "not yours", deliberately. Telling
    // the two apart would confirm to a stranger that a given hire id exists,
    // which is the thing an id-guessing attempt is trying to learn.
    return (
      <section className="wrap section">
        <div className="stack stack-16" style={{ maxWidth: '40rem' }}>
          <h1 className="h2">No hire here.</h1>
          <p className="lead">
            Either this hire does not exist, or it belongs to a different browser. Hires are scoped
            to the browser that created them, so opening someone else&rsquo;s link shows you this
            page.
          </p>
          <div>
            <Link href="/agents" className="btn btn-primary btn-sm">
              Back to the catalog
            </Link>
          </div>
        </div>
      </section>
    );
  }

  const left = remaining(hire.mandate, hire.mandateState);
  const tampered = verifyTrace(hire.trace);
  const live = !['revoked', 'settled', 'failed'].includes(hire.state);

  return (
    <section className="wrap section">
      <div className="stack stack-32" style={{ maxWidth: '52rem' }}>
        <div className="stack stack-16">
          <Link href="/hires" className="small" style={{ textDecoration: 'none' }}>
            &larr; Your hires
          </Link>
          <div className="row" style={{ gap: '0.6rem' }}>
            <span className={hire.state === 'active' ? 'badge badge-live' : 'badge badge-blocked'}>
              {hire.state}
            </span>
            {hire.failureReason ? (
              <span className="badge badge-blocked">{hire.failureReason}</span>
            ) : null}
          </div>
          <h1 className="h2">Agent #{hire.agent.tokenId.toString()}</h1>
          <p className="tiny mono break">{hire.id}</p>
        </div>

        <div className="grid grid-3">
          {[
            ['Spend remaining', tokens(left.spend)],
            ['Actions remaining', String(left.actions)],
            ['Expires', hire.mandate.bounds.expiresAt.toISOString().slice(0, 16).replace('T', ' ')],
          ].map(([k, v]) => (
            <div key={k} className="card stack stack-4">
              <span className="tiny">{k}</span>
              <span className="mono ink" style={{ fontSize: '1.15rem', fontWeight: 700 }}>
                {v}
              </span>
            </div>
          ))}
        </div>

        <div className="card stack stack-12">
          <h2 className="h3">The mandate</h2>
          {/*
            Stated next to the bounds it qualifies. An unsigned mandate is a set
            of limits the owner chose but never cryptographically authorised -
            genuinely weaker than a signed one, and the difference is exactly
            what the gate rests on, so it cannot be left to be assumed.
          */}
          {hire.mandateSignature === null ? (
            <p className="quote" style={{ borderColor: 'var(--blocked)' }}>
              Unsigned. These bounds were set by the owner in this session but not signed by a
              wallet, so they are enforced by Bench rather than authorised on chain.
            </p>
          ) : (
            <p className="quote">
              Signed by <span className="mono break">{hire.mandateSignature.signer}</span> over the
              mandate digest.
            </p>
          )}
          <div className="tablewrap">
            <table className="t">
              <tbody>
                <tr>
                  <td>Total ceiling</td>
                  <td className="num mono">{tokens(hire.mandate.bounds.totalSpendCap.amount)}</td>
                </tr>
                <tr>
                  <td>Per transaction</td>
                  <td className="num mono">{tokens(hire.mandate.bounds.perTxCap.amount)}</td>
                </tr>
                <tr>
                  <td>Max actions</td>
                  <td className="num mono">{hire.mandate.bounds.maxActions}</td>
                </tr>
                <tr>
                  <td>Contracts allowed</td>
                  <td className="num mono">{hire.mandate.bounds.contractAllowlist.length}</td>
                </tr>
                <tr>
                  <td>Escrow job</td>
                  <td className="num mono break">{hire.escrowJobId ?? '-'}</td>
                </tr>
                <tr>
                  <td>Settlement</td>
                  <td className="num mono break">{hire.paymentTxHash ?? '-'}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="tiny">
            The agent carries this, not your key. Every transaction it produces is checked against
            these bounds and against what it did in audition, and must clear both.
          </p>
        </div>

        <div className="card stack stack-12">
          <div className="row-between">
            <h2 className="h3">Decision trace</h2>
            <span className={tampered === null ? 'badge badge-live' : 'badge badge-blocked'}>
              {tampered === null ? 'chain verified' : `tampered at entry ${tampered}`}
            </span>
          </div>
          <div className="trace">
            {hire.trace.map((e) => (
              <div key={e.seq} className="trace-row">
                <span className="trace-seq mono">{e.seq}</span>
                <div className="stack stack-4" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: '0.5rem' }}>
                    <span className="h4">{e.step}</span>
                    <span
                      className={e.outcome === 'ok' ? 'badge badge-live' : 'badge badge-blocked'}
                    >
                      {e.outcome}
                    </span>
                    {e.rules.map((r) => (
                      <span
                        key={r}
                        className="badge badge-plain mono"
                        style={{ fontSize: '0.7rem' }}
                      >
                        {r}
                      </span>
                    ))}
                  </div>
                  <p className="small trace-detail">{e.detail}</p>
                  <p className="tiny mono break" style={{ opacity: 0.55 }}>
                    {e.digest}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <p className="tiny">
            Each entry hashes the one before it, so editing any of them invalidates every entry
            after. Recomputed on every page load - the badge above is the result, not a claim.
          </p>
        </div>

        <div className="slab on-dark stack stack-16">
          <h2 className="h3">Revoke</h2>
          <p className="body">
            Ends the authority immediately. The mandate is marked revoked and every subsequent
            transaction is refused, whether or not it would otherwise have been within bounds.
          </p>
          <form action={revokeHire}>
            <input type="hidden" name="hireId" value={hire.id} />
            <button
              className="btn btn-primary"
              type="submit"
              disabled={!live}
              style={!live ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
            >
              {live ? 'Revoke this hire' : `Already ${hire.state}`}
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
