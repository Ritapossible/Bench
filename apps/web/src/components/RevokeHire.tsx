'use client';

import { useTransition } from 'react';
import { revokeHire } from '@/lib/hire/actions';

/**
 * The revoke control, as a client component so the page is reloaded once the
 * action has actually resolved.
 *
 * As a plain `<form action={revokeHire}>` this was wrong about one time in
 * three. Measured across repeated runs, with the database queried at each
 * step: the action ran every single time and the record really was `revoked`,
 * while the page went on rendering `active` above "Spend remaining 50 USDT" -
 * not briefly, but for as long as anyone waited. Fifteen seconds of polling
 * never corrected it; a reload corrected it every time.
 *
 * Three fixes were tried against the cache theory and measured, not assumed.
 * `revalidatePath` alone: unchanged. Redirecting to the same URL: unchanged,
 * because that is a no-op for the router. Redirecting to a fresh URL: two
 * failures in ten. `router.refresh()`: five in fourteen. Only a full document
 * load was right every time it was observed, so that is what this does.
 *
 * It is a heavy hammer for a page transition, and the right one here. Revoke
 * is deliberate, terminal and rare - nobody revokes twice - so one reload
 * costs a reader nothing, and this is the screen where being wrong costs the
 * most. Someone who has just withdrawn an agent's authority to spend and is
 * told the authority is still live has only two readings available: "revoke is
 * broken" or "revoke failed silently". Both are false, and both are good
 * reasons to stop believing every other number on the site.
 *
 * Without JavaScript the form still posts and the action still runs, and that
 * path returns a fresh document anyway - it was never the broken one.
 */
export function RevokeHire({
  hireId,
  live,
  state,
}: {
  readonly hireId: string;
  readonly live: boolean;
  readonly state: string;
}) {
  const [pending, start] = useTransition();

  return (
    <form
      action={(formData: FormData) => {
        start(async () => {
          await revokeHire(formData);
          // A full reload, not router.refresh(). See the note above: the soft
          // refresh still left the page on `active` five times in fourteen.
          window.location.reload();
        });
      }}
    >
      <input type="hidden" name="hireId" value={hireId} />
      <button
        className="btn btn-primary"
        type="submit"
        disabled={!live || pending}
        style={!live || pending ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
      >
        {live ? (pending ? 'Revoking…' : 'Revoke this hire') : `Already ${state}`}
      </button>
    </form>
  );
}
