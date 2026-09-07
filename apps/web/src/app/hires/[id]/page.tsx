import Link from 'next/link';
import { isAuthorityLive, remaining, verifyTrace } from '@bench/core';
import { hireStore } from '@/lib/hire/runtime';
import { currentOwnerReadOnly } from '@/lib/hire/owner';
import { proposeAction, revokeHire } from '@/lib/hire/actions';

export const metadata = { title: 'Hire - Bench' };
export const dynamic = 'force-dynamic';

// The symbol comes from the hire's own mandate, so a record settled in $U does
// not render as USDT because a constant said so.
const tokens = (n: bigint, symbol = 'USDT') => `${(Number(n) / 1e18).toFixed(2)} ${symbol}`;

/** What the last gate decision, or a refusal to reach one, is called. */
const OUTCOME: Record<string, { readonly kind: 'ok' | 'warn'; readonly text: string }> = {
  allowed: {
    kind: 'ok',
    text: 'Allowed. Both bounds cleared, and the decision is the newest entry in the trace below.',
  },
  blocked: {
    kind: 'warn',
    text: 'Blocked. One of the bounds refused it - the trace below names every rule that fired.',
  },
  'malformed-action': {
    kind: 'warn',
    text: 'That proposal was not a valid action. A recipient address and 0x-prefixed calldata are required.',
  },
  'action-failed': {
    kind: 'warn',
    text: 'The gate could not reach a decision - this hire may no longer be active.',
  },
};

export default async function HireDetail({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const flag = typeof sp['decided'] === 'string' ? sp['decided'] : sp['error'];
  const outcome = typeof flag === 'string' ? (OUTCOME[flag] ?? null) : null;
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
            Either this hire does not exist, or it belongs to a different browser.
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
  const live = isAuthorityLive(hire.state);

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

        {/*
          Labelled by whether the authority is still alive.
          A revoked hire rendered "Spend remaining 50.00 USDT / Actions
          remaining 20 / Expires tomorrow" - three numbers that are all
          arithmetically true and together read as an agent that can still
          spend fifty dollars. The headroom was never used; the authority to
          use it is gone. Those are different facts and the page said only the
          first, on the screen a reader lands on immediately after revoking.
        */}
        <div className="grid grid-3">
          {[
            [
              live ? 'Spend remaining' : 'Spend never used',
              tokens(left.spend, hire.mandate.bounds.totalSpendCap.symbol),
            ],
            [live ? 'Actions remaining' : 'Actions never used', String(left.actions)],
            [
              live ? 'Expires' : 'Would have expired',
              hire.mandate.bounds.expiresAt.toISOString().slice(0, 16).replace('T', ' '),
            ],
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
              Unsigned - set in this session and enforced by Bench, not authorised on chain.
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
                  <td className="num mono">
                    {tokens(
                      hire.mandate.bounds.totalSpendCap.amount,
                      hire.mandate.bounds.totalSpendCap.symbol,
                    )}
                  </td>
                </tr>
                <tr>
                  <td>Per transaction</td>
                  <td className="num mono">
                    {tokens(
                      hire.mandate.bounds.perTxCap.amount,
                      hire.mandate.bounds.perTxCap.symbol,
                    )}
                  </td>
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
            The agent carries this, not your key. Every proposed action must clear both these bounds
            and the audition envelope. Nothing is signed or broadcast here.
          </p>
        </div>

        <div className="card stack stack-12">
          <div className="stack stack-8">
            <h2 className="h3">Put an action through the gate</h2>
            <p className="small">
              Evaluated against this agent&rsquo;s audition behaviour and what this hire has already
              spent. Nothing is signed here; the decision is appended to the trace below.
            </p>
          </div>
          {outcome === null ? null : (
            <p
              className={outcome.kind === 'ok' ? 'notice notice-ok' : 'notice notice-warn'}
              role="status"
            >
              {outcome.text}
            </p>
          )}
          <form action={proposeAction} className="propose">
            <input type="hidden" name="hireId" value={hire.id} />
            <label className="field">
              <span className="tiny">Recipient</span>
              <input
                name="to"
                required
                pattern="0x[a-fA-F0-9]{40}"
                placeholder="0x…"
                className="input mono"
                defaultValue={hire.mandate.bounds.contractAllowlist[0] ?? ''}
              />
            </label>
            <label className="field">
              <span className="tiny">Value (BNB)</span>
              <input
                name="valueEth"
                type="number"
                min="0"
                step="0.01"
                defaultValue="0"
                className="input mono"
              />
            </label>
            <label className="field">
              <span className="tiny">Calldata</span>
              <input name="data" placeholder="0x" defaultValue="0x" className="input mono" />
            </label>
            <button type="submit" className="btn btn-outline btn-sm" disabled={!live}>
              {live ? 'Check against the bounds' : 'Hire is not active'}
            </button>
          </form>
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
            Each entry hashes the one before it, so an edit invalidates everything after. The badge
            above is recomputed on load, not stored.
          </p>
        </div>

        <div className="slab on-dark stack stack-16">
          <h2 className="h3">Revoke</h2>
          <p className="body">
            Ends the authority immediately. Every subsequent transaction is refused.
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
