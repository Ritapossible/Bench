'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { data } from '@/lib/data/index';

/**
 * Ask for an audition against a pasted position.
 *
 * A Server Action rather than something the page does while rendering: the
 * report URL is meant to be shared, and queueing work on every render would
 * fork a chain for every crawler and every refresh. The read path is a GET
 * that only ever looks.
 */
export async function requestReport(form: FormData): Promise<void> {
  const address = String(form.get('address') ?? '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) redirect('/report');

  await data.requestReport(address);
  revalidatePath('/report');
  redirect(`/report?address=${address}`);
}
