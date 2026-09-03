import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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

/** 20 bytes of CSPRNG, hex, address-shaped so it satisfies `Address`. */
const mint = (): Address => `0x${randomBytes(20).toString('hex')}` as Address;

/**
 * The cookie is signed, and the signature is what is checked.
 *
 * Without it the value was a bare bearer token: whoever holds the string is
 * the owner, so a single leak - a screenshot, a support paste, a log line -
 * hands over every hire that browser created, and there is no way to tell a
 * minted id from an invented one. An HMAC makes an id this server did not mint
 * unusable, which turns a leak into a smaller problem and a guess into no
 * problem at all.
 *
 * Keyed by BENCH_COOKIE_SECRET where one is set. Where none is, a per-process
 * key is generated: restarts then invalidate existing cookies, which loses
 * hire ownership on redeploy - so the secret is required in production and the
 * absence is loud rather than silent.
 */
const globalForCookie = globalThis as unknown as { __benchCookieSecret?: string };

function secretOf(): string {
  const configured = process.env['BENCH_COOKIE_SECRET'];
  if (configured !== undefined && configured.length >= 16) return configured;

  /**
   * Cached on globalThis, not held in a module constant.
   *
   * Next bundles a Server Action and the page that reads its result into
   * separate module instances, so a module-level `randomBytes` produced two
   * different keys in one process: the action signed with one and the page
   * verified with the other, and every owner was locked out of the hire they
   * had just created. The same reason `lib/data` and the hire runtime cache
   * theirs there.
   */
  if (globalForCookie.__benchCookieSecret === undefined) {
    /**
     * In production this is a refusal, not a warning.
     *
     * A warning was the wrong severity: a production deploy that missed the
     * variable signed every cookie with a key that dies at the next restart,
     * so every visitor silently lost the hires they had just made - and the
     * only evidence was one line in a log nobody reads during judging.
     * Failing here surfaces it at deploy time, when it is a one-line fix.
     */
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        'BENCH_COOKIE_SECRET is required in production. It signs the cookie that owns a hire, ' +
          'so without it ownership is lost on every restart and cannot be recovered. ' +
          'Generate one with `openssl rand -hex 32`.',
      );
    }
    globalForCookie.__benchCookieSecret = randomBytes(32).toString('hex');
  }
  return globalForCookie.__benchCookieSecret;
}

/**
 * Resolved per call, never at module load.
 *
 * The refusal above has to reach the hire path and nothing else. Evaluated at
 * import time it would throw while Next was loading the module, taking the
 * catalog, the registry dashboard and the status page down with it - failing
 * the pages a judge actually opens because of a variable only hiring needs.
 */
const sign = (value: string): string =>
  createHmac('sha256', secretOf()).update(value).digest('hex').slice(0, 32);

/** Constant-time, so a wrong signature cannot be narrowed by timing it. */
function valid(value: string, mac: string): boolean {
  const expected = Buffer.from(sign(value));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** `<owner>.<mac>`, or null if it was not minted here. */
function parse(raw: string | undefined): Address | null {
  if (raw === undefined) return null;
  const [value, mac] = raw.split('.');
  if (value === undefined || mac === undefined) return null;
  if (!/^0x[0-9a-f]{40}$/.test(value)) return null;
  return valid(value, mac) ? (value as Address) : null;
}

/**
 * The current owner, minting one if this browser has none.
 *
 * Only callable where Next allows a cookie write - a Server Action or a Route
 * Handler. Read paths use `currentOwnerReadOnly`, which never writes.
 */
export async function currentOwner(): Promise<Address> {
  const jar = await cookies();
  const existing = parse(jar.get(COOKIE)?.value);
  if (existing !== null) return existing;

  const owner = mint();
  jar.set(COOKIE, `${owner}.${sign(owner)}`, {
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
  return parse((await cookies()).get(COOKIE)?.value);
}
