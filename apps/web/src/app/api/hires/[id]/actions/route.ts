import { NextResponse } from 'next/server';
import { actionRecordFor } from '@bench/core';
import { hireStore } from '@/lib/hire/runtime';

/**
 * The action record a dispute is replayed against.
 *
 * **This URL is pinned into the hire's registration on the arbiter, before
 * anyone knows there will be a dispute.** Every GenLayer validator fetches it
 * independently during adjudication and they compare what they parsed, so it
 * has to be public, stable, and identical on every request that is not
 * separated by a new action.
 *
 * Public, unlike every other hire surface in this app. `/hires/[id]` is scoped
 * to the browser that made the hire, because a mandate, its bounds and its full
 * decision trace are the hirer's business. This is deliberately narrower than
 * that page: the admitted actions and the moment the mandate was revoked, and
 * nothing else - no owner address, no session key, no mandate, no trace, no
 * task specification. It is the evidence and only the evidence, published under
 * an opaque id the hirer chose to pin at hire time.
 *
 * Bench publishing nothing here is not neutrality. An arbiter that cannot read
 * a record answers `unresolved`, every time, which silently favours whoever is
 * already holding the money.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const hire = await hireStore().get(id);
  if (hire === null) {
    return NextResponse.json({ error: 'no such hire' }, { status: 404 });
  }

  /**
   * A hire that never recorded anything is 404, not an empty record.
   *
   * The two are different claims and the arbiter rules differently on them: an
   * empty record says "nothing happened, so nothing was breached" and can
   * dismiss a dispute, while an unreachable one goes unresolved. Rows written
   * before the record existed have no actions, and answering for them with `[]`
   * would clear an agent on evidence Bench does not have.
   */
  if (hire.actions === undefined) {
    return NextResponse.json({ error: 'no action record for this hire' }, { status: 404 });
  }

  return NextResponse.json(actionRecordFor(hire), {
    headers: {
      // Validators fetch this independently and compare what they parsed. A
      // cached copy served to one and not another is a disagreement about
      // evidence, which the arbiter correctly refuses to rule through.
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}
