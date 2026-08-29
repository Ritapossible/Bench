import 'server-only';
import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import type { Address } from '@bench/core';

/**
 * Who the current visitor is, for the purposes of owning hires.
 *
 * Every hire used to belong to one hardcoded `DEMO_OWNER`, which made
 * `/hires` a single global list: every visitor saw every other visitor's
 * hires, and `revokeHire` accepted any hire id from any form with no ownership
 * check at all. During judging that is a shared mutable list.
 *
 * This is not wallet authentication - hiring does not yet require a signature,
 * and inventing a login for a demo would be worse than the problem. It is a
 * per-browser identity: a random opaque id in an httpOnly cookie, deterministic
 * mapped to an address-shaped owner so the domain keeps its `Address` type.
 * Two visitors get two catalogs of hires, and one cannot revoke the other's.
 *
 * When a wallet is connected the connected address replaces this and the same
 * ownership checks apply unchanged.
 */

const COOKIE = 'bench_owner';
/** A year: a hire outliving the session that created it is the point. */
const MAX_AGE_SEC = 365 * 24 * 60 * 60;

/** 16 bytes of CSPRNG, hex, address-shaped so it satisfies `Address`. */
const mint = (): Address => `0x${randomBytes(20).toString('hex')}` as Address;

/**
 * The current owner, minting one if this browser has none.
 *
 * Only callable where Next allows a cookie write - a Server Action or a Route
 * Handler. Read paths use `currentOwnerReadOnly`, which never writes.
 */
export async function currentOwner(): Promise<Address> {
  const jar = await cookies();
  const existing = jar.get(COOKIE)?.value;
  if (existing !== undefined && /^0x[0-9a-f]{40}$/.test(existing)) return existing as Address;

  const owner = mint();
  jar.set(COOKIE, owner, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: MAX_AGE_SEC,
  });
  return owner;
}

/**
 * The current owner, or null.
 *
 * Server Components cannot set cookies, so a read that has never hired returns
 * null and the page shows an empty list - which is true - rather than throwing.
 */
export async function currentOwnerReadOnly(): Promise<Address | null> {
  const value = (await cookies()).get(COOKIE)?.value;
  return value !== undefined && /^0x[0-9a-f]{40}$/.test(value) ? (value as Address) : null;
}
