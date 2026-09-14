import { openDispute } from '@/lib/dispute/actions';

/**
 * The form that files a dispute.
 *
 * Deliberately opinionated about which ground a complaint belongs on, because
 * the choice decides what the ruling is worth and a hirer has no way to know
 * that. **Breach is free, deterministic, and recomputable by anyone; delivery
 * costs a model call and comes back with a confidence rather than a proof.**
 * Most complaints that sound like the second are the first in disguise, so the
 * breach option leads and says what it means in the hirer's own vocabulary.
 *
 * Progressive enhancement: a plain `<form action={serverAction}>` with real
 * inputs, no client JavaScript, and no disabled-until-valid states. It submits
 * with scripting off, and every field it accepts is re-parsed on the server
 * because the form is a suggestion and the action is a public endpoint.
 */

const EXAMPLES: Record<'breach' | 'delivery', readonly string[]> = {
  breach: [
    'It sent funds to an address that was never on the allowlist I signed.',
    'It kept spending after I revoked the mandate.',
    'It went past the total cap across the hire.',
  ],
  delivery: [
    'It was hired to rebalance the position to 50/50 and it never rebalanced.',
    'It reported work it did not do.',
  ],
};

export function RaiseDispute({
  hireId,
  minBondGen,
  answerHours,
}: {
  readonly hireId: string;
  /** The contract's floor, so the form cannot offer an amount it would refuse. */
  readonly minBondGen: number;
  readonly answerHours: number;
}) {
  return (
    <details className="stack stack-12">
      <summary className="btn btn-outline btn-sm" style={{ cursor: 'pointer' }}>
        Raise a dispute
      </summary>

      <form action={openDispute} className="stack stack-16" style={{ marginTop: '1rem' }}>
        <input type="hidden" name="hireId" value={hireId} />

        <fieldset className="stack stack-8" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="h4">What went wrong</legend>

          <label className="row" style={{ gap: '0.6rem', alignItems: 'flex-start' }}>
            <input type="radio" name="ground" value="breach" defaultChecked />
            <span className="stack stack-4">
              <span className="small ink">It did something it was not allowed to do</span>
              <span className="tiny">
                Settled by replaying the mandate you signed over what the agent actually did. No
                model runs, nothing to argue with, and anyone can recompute it. Pick this whenever
                it fits - it is the stronger case.
              </span>
              <ul className="tiny" style={{ paddingLeft: '1.1rem', opacity: 0.75 }}>
                {EXAMPLES.breach.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </span>
          </label>

          <label className="row" style={{ gap: '0.6rem', alignItems: 'flex-start' }}>
            <input type="radio" name="ground" value="delivery" />
            <span className="stack stack-4">
              <span className="small ink">It did not do the job</span>
              <span className="tiny">
                Judged by one model call over evidence both sides pin. A judgment with a confidence
                attached, not a proof.
              </span>
              <ul className="tiny" style={{ paddingLeft: '1.1rem', opacity: 0.75 }}>
                {EXAMPLES.delivery.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </span>
          </label>
        </fieldset>

        <label className="stack stack-4">
          <span className="small ink">What you hired it to do</span>
          <textarea
            name="engagement"
            required
            maxLength={2000}
            rows={2}
            className="input"
            placeholder="Rebalance my BNB/USDT position toward 50/50 over the next 24 hours."
          />
          <span className="tiny">
            In your own words. The arbiter reads this as context for the statements below.
          </span>
        </label>

        <label className="stack stack-4">
          <span className="small ink">What should have happened, one per line</span>
          <textarea
            name="criteria"
            required
            maxLength={4000}
            rows={3}
            className="input"
            placeholder={
              'The position was rebalanced to within 5% of 50/50.\nNo funds left the allowlist.'
            }
          />
          <span className="tiny">
            Each line is ruled on separately, and one line going against the agent is enough to
            uphold. Statements a document could settle beat opinions - up to eight.
          </span>
        </label>

        <label className="stack stack-4">
          <span className="small ink">Evidence, one https URL per line (optional)</span>
          <textarea
            name="evidenceUrls"
            maxLength={4000}
            rows={2}
            className="input"
            placeholder={
              'https://bscscan.com/address/0x...\nhttps://your-own-records.example/ticket/9'
            }
          />
          <span className="tiny">
            The hire&rsquo;s own action record is always included. A source neither you, the agent,
            nor Bench controls carries far more weight - and the ruling will say which kind it read.
          </span>
        </label>

        <label className="stack stack-4">
          <span className="small ink">Filing bond (GEN)</span>
          <input
            type="number"
            name="bondGen"
            step="0.001"
            min={minBondGen}
            defaultValue={minBondGen}
            required
            className="input"
            style={{ maxWidth: '12rem' }}
          />
          <span className="tiny">
            Returned if the dispute is upheld, and returned if the arbiter cannot decide - failing
            to reach a ruling is not your fault. It goes to the agent only if the arbiter positively
            finds it did the job. Minimum {minBondGen} GEN.
          </span>
        </label>

        <div className="stack stack-8">
          <button type="submit" className="btn btn-primary btn-sm">
            File it
          </button>
          <p className="tiny">
            The agent then has {answerHours} hours to file its own evidence, and nobody can rule
            before that window closes. Bench does not decide this: we list this agent and take a cut
            of this hire.
          </p>
        </div>
      </form>
    </details>
  );
}
