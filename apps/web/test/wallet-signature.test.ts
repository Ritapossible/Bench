import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { toHex, verifyMessage } from 'viem';

/**
 * The tolerance in `signedBy`, pinned.
 *
 * The strict one-line check rejected a real signature from a real wallet on a
 * real phone, and the failure read as "you signed with the wrong account" -
 * which is what makes these worth a test rather than a comment. Recovery
 * against the wrong `v`, or against bytes the wallet hashed differently, does
 * not fail loudly: it returns a different address, cleanly.
 *
 * Duplicated here rather than imported because the module it lives in carries
 * `'use server'`, and importing that into a test pulls `next/headers` and a
 * request scope that does not exist. What is being asserted is the rule, and
 * the rule is small enough to state twice and keep honest.
 */
const flipParity = (signature: string): string | null => {
  const body = signature.startsWith('0x') ? signature.slice(2) : signature;
  if (body.length !== 130) return null;
  const v = Number.parseInt(body.slice(128), 16);
  if (v !== 0 && v !== 1) return null;
  return `0x${body.slice(0, 128)}${(v + 27).toString(16).padStart(2, '0')}`;
};

const signedBy = async (address: string, message: string, signature: string): Promise<boolean> => {
  for (const candidate of [message, toHex(message)]) {
    for (const sig of [signature, flipParity(signature)]) {
      if (sig === null) continue;
      try {
        if (
          await verifyMessage({
            address: address as `0x${string}`,
            message: candidate,
            signature: sig as `0x${string}`,
          })
        ) {
          return true;
        }
      } catch {
        /* not an answer about the signer */
      }
    }
  }
  return false;
};

const account = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'43'.repeat(32)}`);
const MESSAGE = 'Sign in to Bench.\n\nNonce: abc123';

describe('wallet signature tolerance', () => {
  it('accepts an ordinary signature', async () => {
    expect(
      await signedBy(account.address, MESSAGE, await account.signMessage({ message: MESSAGE })),
    ).toBe(true);
  });

  it('accepts a v byte of 0 or 1', async () => {
    // EIP-155 settled on 27/28; a number of wallets and hardware devices still
    // return the raw parity.
    const good = await account.signMessage({ message: MESSAGE });
    const raw = `${good.slice(0, -2)}${(Number.parseInt(good.slice(-2), 16) - 27)
      .toString(16)
      .padStart(2, '0')}`;
    expect(await signedBy(account.address, MESSAGE, raw)).toBe(true);
  });

  it('accepts a wallet that signed the hex form literally', async () => {
    // `personal_sign` is specified over hex data, so some wallets hash the hex
    // text rather than the string handed to them.
    const hexSigned = await account.signMessage({ message: toHex(MESSAGE) });
    expect(await signedBy(account.address, MESSAGE, hexSigned)).toBe(true);
  });

  it('still refuses a different signer', async () => {
    // The tolerance widens what a valid signature looks like, never who counts
    // as having signed one.
    const good = await account.signMessage({ message: MESSAGE });
    expect(await signedBy(other.address, MESSAGE, good)).toBe(false);
  });

  it('still refuses a signature over a different nonce', async () => {
    // Otherwise a signature captured once replays for as long as it is held.
    const elsewhere = await account.signMessage({ message: MESSAGE.replace('abc123', 'deadbe') });
    expect(await signedBy(account.address, MESSAGE, elsewhere)).toBe(false);
  });

  it('refuses junk without throwing', async () => {
    expect(await signedBy(account.address, MESSAGE, '0xnotasignature')).toBe(false);
    expect(await signedBy(account.address, MESSAGE, '0x')).toBe(false);
  });
});
