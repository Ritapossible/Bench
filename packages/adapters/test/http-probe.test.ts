import type { AgentId } from '@bench/core';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpProbeClient, extractSseData } from '../src/probe/http-probe.js';

/**
 * The distinction these tests exist to protect: **reachable is not
 * conformant.** A parked domain returning 200 to everything is a live web
 * server, not a live agent. If the prober cannot tell them apart, the
 * "verified live" filter rebuilds exactly the empty directory Bench exists to
 * replace — just with a green dot on it.
 */
const agent: AgentId = { chain: 'bsc-testnet', tokenId: 1n };

describe('extractSseData', () => {
  it('passes plain JSON through', () => {
    expect(extractSseData('{"a":1}')).toBe('{"a":1}');
  });

  it('unwraps an SSE frame, since MCP streamable-HTTP may answer either way', () => {
    expect(extractSseData('event: message\ndata: {"a":1}\n\n')).toBe('{"a":1}');
  });
});

describe('HttpProbeClient', () => {
  let server: Server;
  let port: number;
  const probes = new HttpProbeClient({ allowLoopback: true, timeoutMs: 2_000 });
  const url = (p: string): string => `http://127.0.0.1:${port}${p}`;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const json = (code: number, body: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      // --- A2A ---
      if (path === '/.well-known/agent.json') {
        json(200, { name: 'Good Agent', url: url('/a2a'), capabilities: { streaming: false } });
        return;
      }
      if (path === '/.well-known/agent-card.json') {
        json(404, {});
        return;
      }

      // --- MCP ---
      if (path === '/mcp') {
        json(200, {
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 's' } },
        });
        return;
      }
      if (path === '/mcp-sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2025-06-18', capabilities: {} },
          })}\n\n`,
        );
        return;
      }
      if (path === '/mcp-error') {
        json(200, { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no' } });
        return;
      }

      // --- OASF ---
      if (path === '/oasf') {
        json(200, { schema_version: '0.3.1', name: 'Descriptor' });
        return;
      }

      // The parked-domain case: answers everything, implements nothing.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>welcome to nginx</html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('marks a real A2A agent conformant', async () => {
    const r = await probes.probe(agent, { protocol: 'a2a', url: url('/a2a') });
    expect(r.reachable).toBe(true);
    expect(r.conformant).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('marks a parked domain reachable but NOT conformant', async () => {
    // The single most important assertion in the prober.
    const nowhere = new HttpProbeClient({ allowLoopback: true });
    const r = await nowhere.probe(agent, { protocol: 'oasf', url: url('/parked') });
    expect(r.reachable).toBe(true);
    expect(r.conformant).toBe(false);
    expect(r.error).toBeDefined();
  });

  it('completes the MCP initialize handshake', async () => {
    const r = await probes.probe(agent, { protocol: 'mcp', url: url('/mcp') });
    expect(r.conformant).toBe(true);
  });

  it('accepts an MCP server that replies over SSE', async () => {
    const r = await probes.probe(agent, { protocol: 'mcp', url: url('/mcp-sse') });
    expect(r.conformant).toBe(true);
  });

  it('rejects an MCP server that errors on initialize', async () => {
    const r = await probes.probe(agent, { protocol: 'mcp', url: url('/mcp-error') });
    expect(r.reachable).toBe(true);
    expect(r.conformant).toBe(false);
    expect(r.error).toMatch(/initialize errored/);
  });

  it('accepts a valid OASF descriptor', async () => {
    const r = await probes.probe(agent, { protocol: 'oasf', url: url('/oasf') });
    expect(r.conformant).toBe(true);
  });

  it('reports an unreachable endpoint without throwing', async () => {
    // A dead endpoint is the common case, so it must be a recorded result
    // rather than an exception the prober has to catch per call.
    const r = await probes.probe(agent, { protocol: 'a2a', url: 'http://127.0.0.1:1/a2a' });
    expect(r.reachable).toBe(false);
    expect(r.conformant).toBe(false);
    expect(r.latencyMs).toBeNull();
    expect(r.error).toBeDefined();
  });

  it('refuses an endpoint pointed at internal infrastructure', async () => {
    // Loopback disabled here: this is the production configuration.
    const guarded = new HttpProbeClient({ allowLoopback: false });
    const r = await guarded.probe(agent, { protocol: 'a2a', url: 'http://169.254.169.254/' });
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/blocked/);
  });
});
