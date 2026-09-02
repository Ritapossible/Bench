import { BenchError } from '@bench/core';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertPublicUrl, clearDnsCache, dnsCacheSize, safeFetch } from '../src/net/safe-fetch.js';

/**
 * Every URL Bench fetches in Phase 1 is written by whoever registered the
 * agent, and registration is gas-free on BSC testnet. These tests are the
 * check that a hostile tokenURI cannot turn the worker — which holds Postgres
 * credentials and RPC access — into a proxy for reaching our own network.
 */
describe('assertPublicUrl', () => {
  it('blocks cloud instance metadata', async () => {
    // 169.254.169.254 is the single highest-value SSRF target on any cloud host.
    await expect(
      assertPublicUrl('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toBeInstanceOf(BenchError);
  });

  it('blocks loopback, which is where our own database lives', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:5432/')).rejects.toBeInstanceOf(BenchError);
    await expect(assertPublicUrl('http://[::1]:6379/')).rejects.toBeInstanceOf(BenchError);
  });

  it('blocks RFC1918 private ranges', async () => {
    for (const host of ['10.0.0.1', '172.16.5.4', '192.168.1.1']) {
      await expect(assertPublicUrl(`http://${host}/`)).rejects.toBeInstanceOf(BenchError);
    }
  });

  it('blocks IPv4-mapped IPv6, a standard filter bypass', async () => {
    await expect(assertPublicUrl('http://[::ffff:127.0.0.1]/')).rejects.toBeInstanceOf(BenchError);
  });

  it('blocks unique-local and link-local IPv6', async () => {
    await expect(assertPublicUrl('http://[fc00::1]/')).rejects.toBeInstanceOf(BenchError);
    await expect(assertPublicUrl('http://[fe80::1]/')).rejects.toBeInstanceOf(BenchError);
  });

  it('blocks non-HTTP schemes', async () => {
    // file:// and gopher:// are how naive host filters get walked around.
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(BenchError);
    await expect(assertPublicUrl('gopher://evil.example.com/')).rejects.toBeInstanceOf(BenchError);
  });

  it('rejects malformed URLs rather than passing them to fetch', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toBeInstanceOf(BenchError);
  });

  it('permits loopback only when explicitly opted in, for tests', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:1/', true)).resolves.toBeInstanceOf(URL);
  });
});

describe('safeFetch limits', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        // Far past the cap, sent without a content-length so only the
        // streaming limit can stop it.
        res.end('x'.repeat(200_000));
        return;
      }
      if (url === '/slow') {
        setTimeout(() => res.end('too late'), 2_000);
        return;
      }
      if (url === '/redirect-to-metadata') {
        // A public URL that bounces to an internal one: the case that makes
        // manual, re-validated redirect handling necessary.
        res.writeHead(302, { location: 'http://169.254.169.254/' });
        res.end();
        return;
      }
      if (url === '/loop') {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/loop` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const base = { allowLoopback: true } as const;

  it('fetches a normal response', async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/ok`, base);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('truncates a response past the byte cap instead of buffering it all', async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/big`, { ...base, maxBytes: 1024 });
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(1024);
  });

  it('times out a slow endpoint rather than pinning a worker', async () => {
    await expect(
      safeFetch(`http://127.0.0.1:${port}/slow`, { ...base, timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(BenchError);
  });

  it('re-validates redirect targets, so a public URL cannot bounce inward', async () => {
    await expect(
      safeFetch(`http://127.0.0.1:${port}/redirect-to-metadata`, base),
    ).rejects.toBeInstanceOf(BenchError);
  });

  it('gives up on a redirect loop', async () => {
    await expect(
      safeFetch(`http://127.0.0.1:${port}/loop`, { ...base, maxRedirects: 2 }),
    ).rejects.toBeInstanceOf(BenchError);
  });
});

describe('IPv4-mapped IPv6 normalisation', () => {
  /**
   * Regression guard. `new URL()` rewrites these hosts into hex before the
   * filter ever sees them, so a filter matching on the dotted-quad spelling
   * passes them straight through — including to cloud metadata.
   */
  it('blocks every spelling of a mapped internal address', async () => {
    for (const host of [
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '[0:0:0:0:0:ffff:169.254.169.254]',
      '[::ffff:a9fe:a9fe]',
      '[::ffff:10.0.0.1]',
      '[::ffff:192.168.1.1]',
    ]) {
      await expect(assertPublicUrl(`http://${host}/`), host).rejects.toBeInstanceOf(BenchError);
    }
  });

  it('still permits a genuinely public mapped address', async () => {
    await expect(assertPublicUrl('http://[::ffff:8.8.8.8]/')).resolves.toBeInstanceOf(URL);
  });

  it('blocks an unparseable IPv6 literal rather than letting it through', async () => {
    await expect(assertPublicUrl('http://[::ffff:zzzz:1]/')).rejects.toBeInstanceOf(BenchError);
  });
});

describe('name resolution', () => {
  beforeEach(() => {
    clearDnsCache();
  });

  it('resolves a host once however many times it is fetched', async () => {
    // An A2A probe fetches three URLs on one host. Resolving three times put
    // three jobs on a four-thread pool per agent, and that queue - not any
    // endpoint - is what spent the probe's timeout.
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      // A name, not a literal address - a literal skips the resolver entirely.
      const url = `http://localhost:${port}/`;
      expect(dnsCacheSize()).toBe(0);
      await safeFetch(url, { allowLoopback: true });
      await safeFetch(url, { allowLoopback: true });
      await safeFetch(url, { allowLoopback: true });
      expect(dnsCacheSize()).toBe(1);
    } finally {
      server.close();
    }
  });

  it('reports a slow resolver as a slow resolver, not a slow endpoint', async () => {
    // The whole point of splitting the budgets. Folding DNS into the request
    // timeout made every slow lookup read as `timeout after 5000ms`, which
    // blames the endpoint and sends you hunting a network fault.
    await expect(
      safeFetch('http://a-host-that-does-not-resolve.invalid/', { dnsTimeoutMs: 1 }),
    ).rejects.toThrow(/DNS lookup (timed out|failed)/);
  });

  it('does not spend the request budget on resolution', async () => {
    // A host that resolves must still get its full request budget afterwards.
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('ok');
      }, 150);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await safeFetch(`http://localhost:${port}/`, {
        allowLoopback: true,
        timeoutMs: 400,
      });
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('still refuses a name that resolves to a private address', async () => {
    // Caching must not become a way past the address filter.
    await expect(assertPublicUrl('http://localhost:1/')).rejects.toThrow(/blocked/);
  });
});
