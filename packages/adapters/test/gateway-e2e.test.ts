import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { InterceptedAction } from '@bench/core';
import { AnvilForkProvider } from '../src/shadow/anvil-fork.js';
import { RpcGateway } from '../src/shadow/rpc-gateway.js';
import { anvilAvailable } from './helpers/anvil.js';

/**
 * The property the whole product rests on: an agent that is not on this host
 * can drive the forked chain, and the interceptor records what it did.
 *
 * It could not, and nothing said so. The interceptor binds to loopback -
 * correctly, since it can mint balances - and that loopback URL was handed to
 * agents running on other people's infrastructure. So no registered agent ever
 * reached the chain, none could transact, and `terminal - doNothing` was
 * exactly zero for every one of them. Production showed one completed
 * audition at +$0.00 with zero transactions, and that was not a thin sample:
 * it was the only number the architecture could produce.
 *
 * This test drives a real anvil through a real gateway with a client that is
 * given nothing but the public URL. If it ever passes a loopback address to
 * that client again, the assertion below fails.
 */
describe.skipIf(!anvilAvailable())('a remote agent drives a real fork', () => {
  const CHAIN_ID = 31337;
  const RECIPIENT = `0x${'22'.repeat(20)}` as const;

  /** The worker's single public port, which the gateway shares with /health. */
  async function publicPort(gateway: RpcGateway): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => {
      void gateway.handle(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end('not mine');
        }
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    return { server, port };
  }

  it('records a transaction from a client that only ever saw the public URL', async () => {
    // Bound late: the gateway has to advertise the port the server actually
    // got, which is the same ordering the worker has with PORT.
    let advertised = '';
    const gateway = new RpcGateway({
      get publicBaseUrl() {
        return advertised;
      },
    } as never);
    const { server, port } = await publicPort(gateway);
    advertised = `http://127.0.0.1:${port}`;

    const provider = new AnvilForkProvider({ forkless: true, chainId: CHAIN_ID, gateway });
    const fork = await provider.spawn({
      window: { id: 'w', label: 'w', regime: 'live', forkBlock: 0n, endBlock: 1n, seed: 'seed' },
      archiveRpcUrl: 'unused',
    } as never);

    // Collected through the same callback the audition runner uses, so this
    // exercises the recording path rather than a test-only accessor.
    const actions: InterceptedAction[] = [];
    fork.onAction((a) => actions.push(a));

    try {
      const url = fork.rpcUrl;
      // The agent is handed a routable address, not this machine's loopback.
      expect(url).toBe(`${advertised}/rpc/${url.split('/rpc/')[1] ?? ''}`);
      expect(url).toMatch(/\/rpc\/[0-9a-f]{64}$/);

      // Everything below speaks only to `url`.
      const pub = createPublicClient({ transport: http(url) });
      expect(await pub.getChainId()).toBe(CHAIN_ID);

      /**
       * Anvil's first pre-funded account, not a cheat call.
       *
       * This test used to fund a fresh key by calling `anvil_setBalance`
       * through the gateway - which worked, and was the hole: every cheat code
       * anvil exposes was reachable by anything holding the run's URL, and that
       * URL is public by construction. An agent could mint itself a balance and
       * post the delta as a result. The refusal is asserted below; here the
       * wallet just uses money anvil already gave it.
       */
      const account = privateKeyToAccount(
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      );

      const cheat = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'anvil_setBalance',
          params: [account.address, `0x${(10n ** 30n).toString(16)}`],
        }),
      }).then((r) => r.json() as Promise<{ error?: { message?: string } }>);
      expect(cheat.error?.message).toMatch(/not available during an audition/);

      // And the unsigned send, which executed past the gate on the impersonated
      // controller and never appeared in the recorded actions.
      const unsigned = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'eth_sendTransaction',
          params: [{ from: account.address, to: RECIPIENT, value: '0x1' }],
        }),
      }).then((r) => r.json() as Promise<{ error?: { message?: string } }>);
      expect(unsigned.error?.message).toMatch(/eth_sendRawTransaction/);

      const wallet = createWalletClient({
        account,
        transport: http(url),
        chain: {
          id: CHAIN_ID,
          name: 'fork',
          nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
          rpcUrls: { default: { http: [url] } },
        } as never,
      });
      const hash = await wallet.sendTransaction({
        to: RECIPIENT,
        value: 1n,
        gas: 21_000n,
      } as never);
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);

      // Recorded by the interceptor, which is what an audition measures. This
      // is the assertion that was impossible to satisfy before.
      expect(actions).toHaveLength(1);
      expect(actions[0]?.to?.toLowerCase()).toBe(RECIPIENT);
      expect(actions[0]?.value).toBe(1n);
    } finally {
      await fork.destroy();
      server.close();
    }
  }, 90_000);

  it('stops answering the moment the fork is destroyed', async () => {
    let advertised = '';
    const gateway = new RpcGateway({
      get publicBaseUrl() {
        return advertised;
      },
    } as never);
    const { server, port } = await publicPort(gateway);
    advertised = `http://127.0.0.1:${port}`;

    const provider = new AnvilForkProvider({ forkless: true, chainId: CHAIN_ID, gateway });
    const fork = await provider.spawn({
      window: { id: 'w', label: 'w', regime: 'live', forkBlock: 0n, endBlock: 1n, seed: 'seed' },
      archiveRpcUrl: 'unused',
    } as never);
    const url = fork.rpcUrl;
    await fork.destroy();

    try {
      const res = await fetch(url, { method: 'POST', body: '{}' });
      expect(res.status).toBe(404);
      expect(gateway.size).toBe(0);
    } finally {
      server.close();
    }
  }, 90_000);
});
