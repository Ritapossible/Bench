'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { connectWallet, disconnect, walletChallenge, walletState } from '@/lib/hire/wallet';

/**
 * Connect a wallet so an identity outlives the browser it was made in.
 *
 * **Signing only, never a transaction.** No chain is touched and the wallet
 * needs no balance - the user signs one message and the server checks that it
 * recovers to the address claimed. That is deliberately the smallest thing that
 * fixes the real problem: a random session id lives in one cookie, so clearing
 * the browser destroys every hire behind it and nobody can prove those hires
 * were theirs. An address is recoverable from any device by signing again.
 *
 * The client's only job is to ask the wallet and hand three strings back. It
 * chooses nothing: the message and its nonce are built on the server, and the
 * address is re-derived there from the signature rather than believed.
 *
 * Degrades honestly. With no injected wallet this says so and hiring carries on
 * under the session identity, because a marketplace that refuses to show you
 * anything until you install something is worse than one that remembers less.
 */

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

const injected = (): Eip1193 | null => {
  const found = (globalThis as { ethereum?: Eip1193 }).ethereum;
  return found ?? null;
};

const short = (a: string): string => `${a.slice(0, 6)}...${a.slice(-4)}`;

type Kind = 'session' | 'wallet' | null;

export function ConnectWallet() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const state = await walletState();
    setAddress(state.address);
    setKind(state.kind);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onConnect(): Promise<void> {
    setError(null);
    const wallet = injected();
    if (wallet === null) {
      setError('No wallet found in this browser. Your hires still work, on this browser only.');
      return;
    }
    try {
      const accounts = (await wallet.request({ method: 'eth_requestAccounts' })) as string[];
      const account = accounts[0];
      if (account === undefined) {
        setError('No account was shared.');
        return;
      }
      // The message and its nonce come from the server, because a challenge the
      // client chooses is a challenge an attacker chooses.
      const { message } = await walletChallenge();
      const signature = (await wallet.request({
        method: 'personal_sign',
        params: [message, account],
      })) as string;

      const form = new FormData();
      form.set('address', account);
      form.set('signature', signature);
      form.set('message', message);

      start(() => {
        void connectWallet(form).then((result) => {
          if (!result.ok) {
            setError(result.error);
            return;
          }
          void refresh();
          router.refresh();
        });
      });
    } catch (err) {
      // A user closing the wallet prompt is not an error worth shouting about.
      const code = (err as { code?: number }).code;
      setError(code === 4001 ? null : 'That wallet request did not complete.');
    }
  }

  if (kind === 'wallet' && address !== null) {
    return (
      <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
        <span className="badge badge-live mono" style={{ fontSize: '0.7rem' }}>
          {short(address)}
        </span>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          disabled={pending}
          onClick={() =>
            start(
              () =>
                void disconnect().then(() => {
                  void refresh();
                  router.refresh();
                }),
            )
          }
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="stack stack-4">
      <button
        type="button"
        className="btn btn-outline btn-sm"
        disabled={pending}
        onClick={() => void onConnect()}
      >
        {pending ? 'Connecting...' : 'Connect wallet'}
      </button>
      {error === null ? null : (
        <span className="tiny" role="status">
          {error}
        </span>
      )}
    </div>
  );
}
