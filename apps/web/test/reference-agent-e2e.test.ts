import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { InterceptedAction } from '@bench/core';
import { A2AShadowAgent, AnvilForkProvider, RpcGateway } from '@bench/adapters';
import { anvilAvailable } from '../../../packages/adapters/test/helpers/anvil.js';
import { POST } from '../src/app/a2a/route';

/**
 * The loop, end to end, with nothing stubbed between the two ends.
 *
 * A real anvil forking BSC mainnet, the real interceptor and gateway, the real
 * A2A shim, and the reference agent's own route handler behind an HTTP server.
 * The shim is given nothing but a URL, exactly as it is for a stranger's agent.
 *
 * This is the assertion the whole catalog has been unable to make: an agent
 * that is not part of this process received a task, signed a transaction with
 * the key it was handed, and the interceptor recorded what it did. Every
 * `+$0.00` in production traces to one of the links in this chain being
 * broken - loopback RPC, a POST at an agent card, a refusal read as success,
 * and finally a key that was never given.
 */
const ARCHIVE = process.env['TEST_BSC_ARCHIVE_RPC_URL'] ?? 'https://bsc-rpc.publicnode.com';
const USDT = '0x55d398326f99059fF775485246999027B3197955';

describe.skipIf(!anvilAvailable())('the reference agent trades a real fork', () => {
  /** The agent's route, served the way Vercel serves it. */
  async function serveAgent(): Promise<{ server: Server; url: string }> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void POST(
          new Request('http://agent.local/a2a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        ).then(async (out) => {
          res.writeHead(out.status, { 'content-type': 'application/json' });
          res.end(await out.text());
        });
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    return { server, url: `http://127.0.0.1:${port}/a2a` };
  }

  it('receives a task, signs with the key it was given, and is recorded', async () => {
    let advertised = '';
    const gateway = new RpcGateway({
      get publicBaseUrl() {
        return advertised;
      },
    } as never);
    const gatewayServer = createServer((req, res) => {
      void gateway.handle(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end('not mine');
        }
      });
    });
    const gatewayPort = await new Promise<number>((resolve) => {
      gatewayServer.listen(0, '127.0.0.1', () =>
        resolve((gatewayServer.address() as { port: number }).port),
      );
    });
    advertised = `http://127.0.0.1:${gatewayPort}`;

    const head = await currentBlock();
    const provider = new AnvilForkProvider({ gateway });
    const fork = await provider.spawn({
      window: {
        id: 'ref-e2e',
        label: 'reference agent check',
        regime: 'live',
        // Behind head, so the fork is not racing reorgs on the public node.
        forkBlock: head - 50n,
        endBlock: head - 40n,
        seed: 'ref-e2e-seed',
      },
      archiveRpcUrl: ARCHIVE,
    } as never);

    const actions: InterceptedAction[] = [];
    fork.onAction((a) => actions.push(a));
    const agentHttp = await serveAgent();

    try {
      /**
       * Deliberately lopsided: all stablecoin, almost no native beyond gas.
       * A position already at 50/50 is one the agent should correctly leave
       * alone, which would make this test pass without proving anything.
       */
      const template = {
        kind: 'spot-balance',
        label: 'USDT and BNB',
        params: {
          nativeWei: 10n ** 18n,
          nativePriceUsd: 600,
          token: USDT.toLowerCase(),
          balanceSlot: 1,
          tokenAmount: 20_000n * 10n ** 18n,
          tokenPriceUsd: 1,
          tokenDecimals: 18,
        },
        capital: { token: USDT.toLowerCase(), symbol: 'USDT', decimals: 18, amount: 0n },
      } as never;
      const seeded = await fork.seedPosition(template);

      const before = await fork.terminalState(template);

      const agent = new A2AShadowAgent({
        id: { chain: 'bsc-mainnet', tokenId: 0n },
        name: 'Bench Reference Rebalancer',
        endpoint: { protocol: 'a2a', url: agentHttp.url },
        allowLoopback: true,
      });

      await agent.run({
        rpcUrl: fork.rpcUrl,
        controller: seeded.controller,
        controllerKey: seeded.controllerKey,
        window: {
          id: 'ref-e2e',
          label: 'reference agent check',
          regime: 'live',
          forkBlock: head - 50n,
          endBlock: head - 40n,
          seed: 'ref-e2e-seed',
        },
        position: template,
        fetch: (async () => new Response('{}')) as never,
      });

      // The point of the whole exercise: the agent moved the position, and the
      // interceptor saw it. Approve plus swap, so at least two.
      expect(actions.length).toBeGreaterThanOrEqual(2);
      expect(actions.every((a) => a.simulated.success)).toBe(true);
      expect(actions.some((a) => a.to?.toLowerCase() === USDT.toLowerCase())).toBe(true);

      const after = await fork.terminalState(template);
      // Value is roughly conserved across a rebalance - the fee and the gas are
      // the difference, and a swap that changed it materially would mean the
      // valuation is reading the wrong thing.
      expect(after.valueUsd).toBeGreaterThan(before.valueUsd * 0.95);
    } finally {
      agentHttp.server.close();
      await fork.destroy();
      gatewayServer.close();
    }
  }, 180_000);
});

async function currentBlock(): Promise<bigint> {
  const res = await fetch(ARCHIVE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  const body = (await res.json()) as { result?: string };
  return BigInt(body.result ?? '0x0');
}
