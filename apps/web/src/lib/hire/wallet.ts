'use server';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { toHex, verifyMessage } from 'viem';
import type { Address } from '@bench/core';
import {
  bindWallet,
  currentOwnerFull,
  currentOwnerReadOnlyFull,
  disconnectWallet,
} from '@/lib/hire/owner';
import { hireStore } from '@/lib/hire/runtime';

/**
 * Connecting a wallet, so an identity survives clearing the browser.
 *
 * **This is identity, not payment.** No transaction is sent, no chain is
 * touched, and the wallet never needs a balance. The user signs one message and
 * the server checks that the signature recovers to the address they claimed;
 * from then on the hire cookie carries that address instead of a random id.
 *
 * Which fixes the thing that made the session identity indefensible: a random
 * id lives in exactly one cookie, so clearing the browser destroys every hire
 * behind it and nobody can ever prove those hires were theirs. An address is
 * recoverable from any browser, on any device, by signing again.
 *
 * A signature is also the only thing that makes ownership a claim rather than a
 * convention. The session cookie proves "same browser"; this proves "same key",
 * which is the same standard the mandate and the dispute layer are held to.
 */

const NONCE_COOKIE = 'bench_wallet_nonce';
/** Long enough to read the prompt and click, short enough that a captured one is stale. */
const NONCE_MAX_AGE_SEC = 10 * 60;

function secretOf(): string {
  const configured = process.env['BENCH_COOKIE_SECRET'];
  if (configured === undefined || configured.length < 16) {
    throw new Error(
      'BENCH_COOKIE_SECRET is required to connect a wallet: it signs the challenge that proves ' +
        'you control the address. Generate one with `openssl rand -hex 32`.',
    );
  }
  return configured;
}

const macOf = (nonce: string): string =>
  createHmac('sha256', secretOf()).update(nonce).digest('hex').slice(0, 32);

function nonceValid(nonce: string, mac: string): boolean {
  const expected = Buffer.from(macOf(nonce));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The exact text the wallet will show, built on the server.
 *
 * Built here rather than in the browser because the nonce has to come from the
 * server to be worth anything - a challenge the client chooses is a challenge
 * an attacker chooses - and because the user should be signing the same bytes
 * the server is about to verify, with no room for the two to differ.
 *
 * It says plainly what signing does. A wallet prompt that shows opaque text
 * trains people to approve opaque text.
 */
export async function walletChallenge(): Promise<{ readonly message: string }> {
  const nonce = randomBytes(16).toString('hex');
  (await cookies()).set(NONCE_COOKIE, `${nonce}.${macOf(nonce)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: NONCE_MAX_AGE_SEC,
  });

  return {
    message: [
      'Sign in to Bench.',
      '',
      'This proves you control this address so your hires are yours on any',
      'device. It is not a transaction: nothing is spent and nothing is',
      'approved.',
      '',
      `Nonce: ${nonce}`,
    ].join('\n'),
  };
}

/**
 * Did this address sign this message? Tolerant of two long-standing wallet
 * quirks, and of nothing else.
 *
 * The strict check is one line, and it rejected a real signature from a real
 * wallet on a real phone. Two incompatibilities are old enough to be part of
 * the landscape rather than bugs to wait out:
 *
 *   **A `v` byte of 0 or 1.** EIP-155 settled on 27/28 and a number of wallets
 *   and hardware devices still return the raw parity. Recovery against the
 *   wrong `v` does not fail loudly - it recovers a different address, which
 *   reads exactly like signing with the wrong account.
 *
 *   **`personal_sign` taking hex.** The method is specified over hex data, so
 *   some wallets sign the hex text literally rather than the string handed to
 *   them. The bytes differ, the recovery is clean, and the address comes back
 *   wrong.
 *
 * Both are tried, and every attempt still has to recover to the address the
 * caller claimed - this widens what a valid signature looks like, never who
 * counts as having signed. Anything still failing here is most likely a
 * contract wallet, which needs an on-chain EIP-1271 check against a chain this
 * server has not been told about, so it is named in the error instead of
 * guessed at.
 */
async function signedBy(address: Address, message: string, signature: string): Promise<boolean> {
  const sigs = [signature, flipParity(signature)];
  // What the wallet may actually have put through the hash.
  const messages = [message, toHex(message)];

  for (const candidate of messages) {
    for (const sig of sigs) {
      if (sig === null) continue;
      try {
        if (
          await verifyMessage({
            address,
            message: candidate,
            signature: sig as `0x${string}`,
          })
        ) {
          return true;
        }
      } catch {
        // A malformed candidate is not an answer about the signer. Try the next.
      }
    }
  }
  return false;
}

/** 65-byte signature with `v` of 0/1 rewritten to 27/28, or null if it is neither. */
function flipParity(signature: string): string | null {
  const body = signature.startsWith('0x') ? signature.slice(2) : signature;
  if (body.length !== 130) return null;
  const v = Number.parseInt(body.slice(128), 16);
  if (v !== 0 && v !== 1) return null;
  return `0x${body.slice(0, 128)}${(v + 27).toString(16).padStart(2, '0')}`;
}

export type ConnectResult =
  | { readonly ok: true; readonly address: Address; readonly moved: number }
  | { readonly ok: false; readonly error: string };

/**
 * Verify the signature and bind the address to this browser.
 *
 * Every input is attacker-supplied - a Server Action is a public endpoint - so
 * the address is never taken on the client's word. `verifyMessage` recovers the
 * signer from the signature and the exact message, and the nonce inside that
 * message has to match the one this server issued and signed.
 */
export async function connectWallet(form: FormData): Promise<ConnectResult> {
  const address = String(form.get('address') ?? '');
  const signature = String(form.get('signature') ?? '');
  const message = String(form.get('message') ?? '');

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { ok: false, error: 'That is not an address.' };
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) return { ok: false, error: 'That is not a signature.' };

  const jar = await cookies();
  const [nonce, mac] = (jar.get(NONCE_COOKIE)?.value ?? '').split('.');
  if (nonce === undefined || mac === undefined || !nonceValid(nonce, mac)) {
    return { ok: false, error: 'That sign-in request expired. Try connecting again.' };
  }
  // The nonce must be the one in the text that was actually signed, or a
  // signature captured over any other message would do.
  if (!message.includes(`Nonce: ${nonce}`)) {
    return { ok: false, error: 'That signature was for a different request.' };
  }

  if (!(await signedBy(address as Address, message, signature))) {
    return {
      ok: false,
      error:
        'That signature does not match the address. Smart-contract wallets are not supported ' +
        'yet - a regular wallet works, and your hires still work here without connecting.',
    };
  }

  // One use only. Without this, a signature observed once could be replayed for
  // as long as the nonce cookie lived.
  jar.delete(NONCE_COOKIE);

  /**
   * Carry the anonymous hires across.
   *
   * Connecting must not look like losing everything. The hires are still there
   * under the session id this browser is about to stop using, and moving them
   * is safe here precisely because both identities have been demonstrated by
   * the same person: one is in this browser's signed cookie, the other has just
   * been proved by signature.
   */
  const previous = await currentOwnerFull();
  const moved =
    previous.kind === 'session'
      ? await hireStore().reassign(previous.address, address.toLowerCase() as Address)
      : 0;

  await bindWallet(address as Address);
  revalidatePath('/hires');
  return { ok: true, address: address.toLowerCase() as Address, moved };
}

/** Disconnect. The hires stay with the address and come back on reconnecting. */
export async function disconnect(): Promise<void> {
  await disconnectWallet();
  revalidatePath('/hires');
}

/**
 * What this browser's identity currently is, for the header to render.
 *
 * Fetched by the widget on mount rather than read in the layout, because
 * reading a cookie in a layout opts every page in the app into dynamic
 * rendering - including the landing page, which has no business being
 * per-request. One round trip in the header is the cheaper trade.
 *
 * Read-only: it never mints. A visitor who has not hired has no identity yet,
 * and inventing one so the header has something to show would put a cookie on
 * every person who ever loads the site.
 */
export async function walletState(): Promise<{
  readonly address: string | null;
  readonly kind: 'session' | 'wallet' | null;
}> {
  const owner = await currentOwnerReadOnlyFull();
  return owner === null
    ? { address: null, kind: null }
    : { address: owner.address, kind: owner.kind };
}
