import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcGateway } from '../src/shadow/rpc-gateway.js';

/**
 * The bug these cover: the interceptor binds to loopback (correctly - it can
 * mint balances), and that loopback URL was handed to agents on other
 * people's infrastructure. No remote agent could reach it, so none could
 * transact, so every measured delta was structurally zero.
 */
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

/** Stands in for the interceptor: a loopback JSON-RPC endpoint. */
async function fakeInterceptor(reply: unknown): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  return { url: `http://127.0.0.1:${port}`, seen };
}

/** Stands in for the worker's public port. */
async function gatewayServer(gw: RpcGateway): Promise<string> {
  const server = createServer((req, res) => {
    void gw.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end('not mine');
      }
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  return `http://127.0.0.1:${port}`;
}

describe('RpcGateway', () => {
  it('gives out a public URL and forwards a call on it to the right fork', async () => {
    const fork = await fakeInterceptor({ jsonrpc: '2.0', id: 1, result: '0x1' });
    const gw = new RpcGateway({ publicBaseUrl: 'https://worker.example' });
    const base = await gatewayServer(gw);

    const route = gw.register(fork.url, 'run-1');
    expect(route.url).toBe(`https://worker.example/rpc/${route.token}`);
    // What the agent is told is no longer a loopback address.
    expect(route.url).not.toContain('127.0.0.1');

    const res = await fetch(`${base}/rpc/${route.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: '0x1' });
    expect(fork.seen[0]).toContain('eth_blockNumber');
  });

  it('routes two live forks to two different upstreams', async () => {
    // Auditions run several forks at once. A gateway that mixed them would
    // credit one agent with another's transactions.
    const a = await fakeInterceptor({ jsonrpc: '2.0', id: 1, result: 'A' });
    const b = await fakeInterceptor({ jsonrpc: '2.0', id: 1, result: 'B' });
    const gw = new RpcGateway({ publicBaseUrl: 'https://worker.example' });
    const base = await gatewayServer(gw);

    const ra = gw.register(a.url, 'run-a');
    const rb = gw.register(b.url, 'run-b');
    const call = async (t: string) =>
      (await (
        await fetch(`${base}/rpc/${t}`, { method: 'POST', body: '{"method":"x"}' })
      ).json()) as { result: string };

    expect((await call(ra.token)).result).toBe('A');
    expect((await call(rb.token)).result).toBe('B');
  });

  it('stops answering once the run is over', async () => {
    // The token is the whole access control, so it has to die with the fork.
    const fork = await fakeInterceptor({ jsonrpc: '2.0', id: 1, result: '0x1' });
    const gw = new RpcGateway({ publicBaseUrl: 'https://worker.example' });
    const base = await gatewayServer(gw);

    const route = gw.register(fork.url, 'run-1');
    gw.unregister(route.token);

    const res = await fetch(`${base}/rpc/${route.token}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('refuses a guessed token', async () => {
    const gw = new RpcGateway({ publicBaseUrl: 'https://worker.example' });
    const base = await gatewayServer(gw);
    const res = await fetch(`${base}/rpc/${'0'.repeat(64)}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('expires a route whose fork never unregistered it', async () => {
    const fork = await fakeInterceptor({ jsonrpc: '2.0', id: 1, result: '0x1' });
    const gw = new RpcGateway({ publicBaseUrl: 'https://worker.example', maxRouteAgeMs: -1 });
    const base = await gatewayServer(gw);
    const route = gw.register(fork.url, 'run-1');

    const res = await fetch(`${base}/rpc/${route.token}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('never tells the caller anything about the host when the fork is gone', async () => {
    // The upstream error names a loopback port. Forwarding it would describe
    // this machine's internals to whoever is driving the agent.
    const gw = new RpcGateway({ publicBaseUrl: 'https://worker.example' });
    const base = await gatewayServer(gw);
    const route = gw.register('http://127.0.0.1:1/', 'run-dead');

    const res = await fetch(`${base}/rpc/${route.token}`, { method: 'POST', body: '{}' });
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text).not.toContain('127.0.0.1');
  });

  it('leaves requests that are not its own alone', async () => {
    // It shares a port with /health, so it must decline cleanly.
    const gw = new RpcGateway({ publicBaseUrl: 'https://worker.example' });
    const base = await gatewayServer(gw);
    expect(await (await fetch(`${base}/health`)).text()).toBe('not mine');
  });

  it('reports that it cannot route publicly when no origin is configured', async () => {
    // The worker turns this into a boot warning, because the failure is
    // otherwise invisible: every agent just scores zero.
    const gw = new RpcGateway({});
    expect(gw.publiclyRoutable).toBe(false);
    expect(gw.register('http://127.0.0.1:9/', 'r').url).toBe('http://127.0.0.1:9/');
  });
});
