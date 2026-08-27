'use client';

import { useMemo, useState } from 'react';
import { createHire } from '@/lib/hire/actions';

/**
 * The consent steps arrive as props rather than being imported from
 * `@bench/core`.
 *
 * That package is the domain, and the domain reaches for `node:crypto` to hash
 * mandates and chain the decision trace - which cannot be bundled for a
 * browser. Passing the steps down from the server component keeps one
 * definition (the server still reads CONSENT_STEPS from core) without dragging
 * Node built-ins into the client bundle.
 */
export interface ConsentStepView {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
}

export interface HireCheckoutProps {
  readonly chain: string;
  readonly tokenId: string;
  readonly agentName: string;
  readonly category: string;
  readonly auditionSummary: string;
  readonly suggestedAllowlist: readonly string[];
  readonly price: number;
  readonly steps: readonly ConsentStepView[];
}

const usd = (n: number) => `${n.toFixed(2)} USDT`;

export function HireCheckout(props: HireCheckoutProps) {
  const [done, setDone] = useState<string[]>([]);
  const [totalCap, setTotalCap] = useState(50);
  const [perTxCap, setPerTxCap] = useState(10);
  const [maxActions, setMaxActions] = useState(20);
  const [expiryHours, setExpiryHours] = useState(24);
  const [allowlist, setAllowlist] = useState(props.suggestedAllowlist.join('\n'));
  const [taskSpec, setTaskSpec] = useState('');

  // Generated once per checkout. A double-submit, a refresh, or a flaky
  // connection reaches the same hire instead of paying twice.
  const idempotencyKey = useMemo(
    () => `web_${Math.random().toString(36).slice(2)}_${Date.now()}`,
    [],
  );

  const current = props.steps.find((s) => !done.includes(s.id))?.id ?? null;
  const confirm = (s: string) => setDone((d) => (d.includes(s) ? d : [...d, s]));
  const reopen = (s: string) => setDone((d) => d.slice(0, d.indexOf(s)));

  const allowCount = allowlist.split(/[\s,]+/).filter((a) => /^0x[a-fA-F0-9]{40}$/.test(a)).length;

  return (
    <form action={createHire} className="stack stack-16">
      <input type="hidden" name="chain" value={props.chain} />
      <input type="hidden" name="tokenId" value={props.tokenId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="price" value={props.price} />
      <input type="hidden" name="totalCap" value={totalCap} />
      <input type="hidden" name="perTxCap" value={perTxCap} />
      <input type="hidden" name="maxActions" value={maxActions} />
      <input type="hidden" name="expiryHours" value={expiryHours} />
      <input type="hidden" name="allowlist" value={allowlist} />
      <input type="hidden" name="taskSpec" value={taskSpec} />
      {/*
        The confirmations the user actually gave, in the order they gave them.
        Submitted rather than assumed: the server used to hardcode a complete
        list, which made `consentComplete` unfailable and the whole checklist
        decorative. It is the one control here that a user can watch working,
        so it has to actually be the thing that is checked.
      */}
      {done.map((step) => (
        <input key={step} type="hidden" name="consent" value={step} />
      ))}

      {props.steps.map(({ id: step, title, prompt }, i) => {
        const state = done.includes(step) ? 'done' : step === current ? 'current' : 'upcoming';
        return (
          <section key={step} className="step" data-state={state}>
            <header className="step-head">
              <span className="step-num" aria-hidden="true">
                {state === 'done' ? '✓' : i + 1}
              </span>
              <div className="stack stack-4" style={{ minWidth: 0 }}>
                <h3 className="h4">{title}</h3>
                <p className="tiny">{prompt}</p>
              </div>
              {state === 'done' ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => reopen(step)}>
                  Change
                </button>
              ) : null}
            </header>

            {state === 'current' ? (
              <div className="step-body stack stack-16">
                {step === 'reviewed-audition' ? (
                  <>
                    <p className="body">{props.auditionSummary}</p>
                    <p className="small">
                      This record is also the bound. A hired agent cannot do anything it did not do
                      here - that is the envelope, and it is fixed at the moment you hire, so it
                      cannot widen afterwards.
                    </p>
                  </>
                ) : null}

                {step === 'set-spend-cap' ? (
                  <div className="grid grid-3">
                    <Field label="Total ceiling" hint="across the whole hire">
                      <input
                        className="field"
                        type="number"
                        min={1}
                        value={totalCap}
                        onChange={(e) => setTotalCap(Number(e.target.value))}
                      />
                    </Field>
                    <Field label="Per transaction" hint="largest single action">
                      <input
                        className="field"
                        type="number"
                        min={1}
                        value={perTxCap}
                        onChange={(e) => setPerTxCap(Number(e.target.value))}
                      />
                    </Field>
                    <Field label="Max actions" hint="stops an in-cap loop">
                      <input
                        className="field"
                        type="number"
                        min={1}
                        value={maxActions}
                        onChange={(e) => setMaxActions(Number(e.target.value))}
                      />
                    </Field>
                  </div>
                ) : null}

                {step === 'set-allowlist' ? (
                  <>
                    <Field
                      label="Contracts it may touch"
                      hint="one address per line; anything else is refused"
                    >
                      <textarea
                        className="field"
                        rows={4}
                        style={{
                          borderRadius: 'var(--r-sm)',
                          fontFamily: 'ui-monospace, monospace',
                          fontSize: '0.85rem',
                        }}
                        value={allowlist}
                        onChange={(e) => setAllowlist(e.target.value)}
                      />
                    </Field>
                    <p className="small">
                      {allowCount} valid address{allowCount === 1 ? '' : 'es'}. Pre-filled from the
                      contracts this agent actually used in audition.
                    </p>
                  </>
                ) : null}

                {step === 'set-expiry' ? (
                  <>
                    <Field label="Authority ends in" hint="hours from now">
                      <input
                        className="field"
                        type="number"
                        min={1}
                        value={expiryHours}
                        onChange={(e) => setExpiryHours(Number(e.target.value))}
                      />
                    </Field>
                    <Field label="What you want done" hint="recorded with the escrow job">
                      <input
                        className="field"
                        value={taskSpec}
                        onChange={(e) => setTaskSpec(e.target.value)}
                        placeholder="keep my Venus health factor above 1.5"
                      />
                    </Field>
                  </>
                ) : null}

                {step === 'reviewed-summary' ? (
                  <div className="stack stack-12">
                    <div className="tablewrap">
                      <table className="t">
                        <tbody>
                          <tr>
                            <td>Agent</td>
                            <td className="num">{props.agentName}</td>
                          </tr>
                          <tr>
                            <td>Price</td>
                            <td className="num mono">{usd(props.price)}</td>
                          </tr>
                          <tr>
                            <td>Total ceiling</td>
                            <td className="num mono">{usd(totalCap)}</td>
                          </tr>
                          <tr>
                            <td>Per transaction</td>
                            <td className="num mono">{usd(perTxCap)}</td>
                          </tr>
                          <tr>
                            <td>Max actions</td>
                            <td className="num mono">{maxActions}</td>
                          </tr>
                          <tr>
                            <td>Contracts allowed</td>
                            <td className="num mono">{allowCount}</td>
                          </tr>
                          <tr>
                            <td>Expires</td>
                            <td className="num mono">{expiryHours}h from now</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="small">
                      Every bound above, as one decision. Nothing is signed and no escrow opens
                      until you confirm here - and you can revoke at any time afterwards.
                    </p>
                  </div>
                ) : null}

                <div>
                  <button type="button" className="btn btn-primary" onClick={() => confirm(step)}>
                    {step === 'reviewed-summary' ? 'Confirm all bounds' : 'Confirm and continue'}
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        );
      })}

      <div className="card stack stack-12">
        <button
          className="btn btn-primary"
          type="submit"
          disabled={current !== null}
          style={current !== null ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
        >
          {current === null
            ? `Hire ${props.agentName}`
            : `Complete all ${props.steps.length} steps to hire`}
        </button>
        <p className="tiny">
          Settlement is simulated on this deployment - the mandate, consent, decision trace and both
          bounds are the real implementations, and x402 and ERC-8183 replace the two stubbed
          adapters without touching them.
        </p>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="stack stack-4">
      <span className="h4">{label}</span>
      <span className="tiny">{hint}</span>
      {children}
    </label>
  );
}
