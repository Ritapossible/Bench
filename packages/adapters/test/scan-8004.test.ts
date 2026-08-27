import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { summarizeAgreement, type AgentId } from '@bench/core';
import {
  buildCrossReference,
  parseAgentPayload,
  Scan8004CrossReference,
} from '../src/catalog/scan-8004.js';

const agent = (n: number): AgentId => ({ chain: 'bsc-testnet', tokenId: BigInt(n) });

async function withServer(
  handler: (url: URL) => { status: number; body: string },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const { status, body } = handler(new URL(req.url ?? '/', 'http://x'));
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const src = (base: string) =>
  new Scan8004CrossReference({
    apiKey: 'test-key',
    baseUrl: base,
    allowLoopback: true,
    requestsPerMinute: 60_000,
    concurrency: 2,
  });

describe('parseAgentPayload', () => {
  it('accepts several plausible encodings, since the schema is unverified', () => {
    expect(parseAgentPayload({ tokenId: '7', endpoints: [1, 2] })).toEqual({
      known: true,
      endpointCount: 2,
    });
    expect(parseAgentPayload({ data: { agentId: 'a', endpointCount: 3 } })).toEqual({
      known: true,
      endpointCount: 3,
    });
    expect(parseAgentPayload({ result: { id: 'x' } })).toEqual({
      known: true,
      endpointCount: null,
    });
  });

  it('treats an explicit not-found as a successful comparison', () => {
    expect(parseAgentPayload({ found: false })).toEqual({ known: false, endpointCount: null });
  });

  it('refuses a shape it does not recognise rather than guessing', () => {
    // Inventing corroboration from an unrecognised body would be worse than
    // publishing nothing, because Bench publishes an agreement figure from it.
    expect(parseAgentPayload({ something: 'else' })).toBeNull();
    expect(parseAgentPayload('nope')).toBeNull();
    expect(parseAgentPayload(null)).toBeNull();
  });
});

describe('buildCrossReference', () => {
  it('is a no-op without a key, and reports that as unconfigured rather than an error', async () => {
    const r = await buildCrossReference().lookup([agent(1)]);
    expect(r.status).toBe('unconfigured');
    expect(r.records).toEqual([]);
  });

  it('treats a blank key as no key', async () => {
    expect((await buildCrossReference({ apiKey: '   ' }).lookup([agent(1)])).status).toBe(
      'unconfigured',
    );
  });

  it('activates as soon as a key is present', () => {
    expect(buildCrossReference({ apiKey: 'k' })).toBeInstanceOf(Scan8004CrossReference);
  });
});

describe('Scan8004CrossReference', () => {
  it('compares what Bench indexed against what the source knows', async () => {
    await withServer(
      (url) =>
        url.pathname.endsWith('/2')
          ? { status: 404, body: '{}' }
          : { status: 200, body: JSON.stringify({ tokenId: '1', endpoints: [{}] }) },
      async (base) => {
        const r = await src(base).lookup([agent(1), agent(2)]);
        expect(r.status).toBe('ok');
        const s = summarizeAgreement(r);
        expect(s.checked).toBe(2);
        expect(s.confirmed).toBe(1);
        expect(s.notFound).toBe(1);
        expect(s.agreementBps).toBe(5_000);
      },
    );
  });

  it('sends the key as a bearer token', async () => {
    let seen: string | undefined;
    const server = createServer((req, res) => {
      seen = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tokenId: '1' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    await src(`http://127.0.0.1:${port}`).lookup([agent(1)]);
    await new Promise<void>((r) => server.close(() => r()));
    expect(seen).toBe('Bearer test-key');
  });

  it('reports unavailable — not zero agreement — when nothing usable comes back', async () => {
    // "0% agreement" would be a claim about the agents. This is a fact about
    // the source, and the distinction matters because Bench publishes one.
    await withServer(
      () => ({ status: 500, body: '{}' }),
      async (base) => {
        const r = await src(base).lookup([agent(1), agent(2)]);
        expect(r.status).toBe('unavailable');
        expect(r.note).toContain('failed');
        expect(summarizeAgreement(r).agreementBps).toBe(0);
      },
    );
  });

  it('omits unrecognised responses from the comparison but keeps the rest', async () => {
    await withServer(
      (url) =>
        url.pathname.endsWith('/1')
          ? { status: 200, body: JSON.stringify({ tokenId: '1' }) }
          : { status: 200, body: '{"weird":true}' },
      async (base) => {
        const r = await src(base).lookup([agent(1), agent(2)]);
        expect(r.status).toBe('ok');
        expect(r.records).toHaveLength(1);
        expect(r.note).toContain('unrecognised');
      },
    );
  });

  it('never throws, whatever the source does', async () => {
    const s = new Scan8004CrossReference({
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1:1',
      allowLoopback: true,
      requestsPerMinute: 60_000,
    });
    await expect(s.lookup([agent(1)])).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('paces requests instead of bursting, which is what trips a rate limiter', async () => {
    await withServer(
      () => ({ status: 200, body: JSON.stringify({ tokenId: '1' }) }),
      async (base) => {
        const paced = new Scan8004CrossReference({
          apiKey: 'k',
          baseUrl: base,
          allowLoopback: true,
          requestsPerMinute: 600,
          concurrency: 4,
        });
        const started = Date.now();
        await paced.lookup([agent(1), agent(2), agent(3), agent(4)]);
        // 600/min = 100ms apart; four requests span at least three intervals.
        expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      },
    );
  }, 15_000);
});
