import { describe, expect, it } from 'vitest';
import { QUEUE, redisOptionsFrom } from '../src/queues.js';
import { startHealthServer } from '../src/health.js';

describe('queue names', () => {
  it('contain no colon', () => {
    // BullMQ throws at construction on a colon - it is the Redis key separator.
    // Every queue name carried one once, and the worker never reached a tick.
    for (const name of Object.values(QUEUE)) {
      expect(name).not.toContain(':');
    }
  });
});

describe('redisOptionsFrom', () => {
  it('resolves both address families', () => {
    // ioredis defaults to family 4, which asks for an A record and nothing
    // else. Railway's private network publishes AAAA only, so the default
    // cannot resolve redis.railway.internal at all.
    const { connection } = redisOptionsFrom('redis://redis.railway.internal:6379');
    expect(connection.family).toBe(0);
  });

  it('keeps a blocking command alive across a reconnect', () => {
    const { connection } = redisOptionsFrom('redis://localhost:6379');
    expect(connection.maxRetriesPerRequest).toBeNull();
  });

  it('enables TLS for rediss:// and not for redis://', () => {
    expect(redisOptionsFrom('rediss://host:6380').connection.tls).toEqual({
      servername: 'host',
    });
    expect(redisOptionsFrom('redis://host:6379').connection.tls).toBeUndefined();
  });

  it('carries credentials, percent-decoded', () => {
    const { connection } = redisOptionsFrom('redis://default:p%40ss%2Fword@host:6379');
    expect(connection.username).toBe('default');
    // Managed Redis passwords are generated, so a `/` or `@` in one is routine
    // and reaches us percent-encoded. Passing the raw form authenticates with
    // the wrong secret.
    expect(connection.password).toBe('p@ss/word');
  });

  it('defaults the port when the URL omits it', () => {
    expect(redisOptionsFrom('redis://host').connection.port).toBe(6379);
  });

  it('omits credentials that are not there', () => {
    const { connection } = redisOptionsFrom('redis://host:6379');
    expect(connection.username).toBeUndefined();
    expect(connection.password).toBeUndefined();
  });
});

describe('health: a queue that succeeds at nothing', () => {
  /**
   * The failure mode that cost the most in this project. The audition queue
   * ran forty times, reported zero failures, and auditioned no agent - nothing
   * was red, and no counter could tell that from working.
   */
  const drain = async (port: number): Promise<Record<string, unknown>> => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return (await res.json()) as Record<string, unknown>;
  };

  it('is up while a queue is doing work, and degraded once it stops', async () => {
    const { heartbeat, server } = startHealthServer(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      heartbeat.mark('bench-audition', 'auditioned=2', 'worked');
      expect((await drain(port))['status']).toBe('up');

      // Five consecutive empty ticks: enough to notice within one cadence,
      // more than the single quiet tick that is normal once caught up.
      for (let i = 0; i < 5; i++) heartbeat.mark('bench-audition', 'auditioned=0', 'idle');

      const body = await drain(port);
      expect(body['status']).toBe('degraded');
      expect(JSON.stringify(body['attention'])).toContain('bench-audition');
    } finally {
      server.close();
    }
  });

  it('recovers as soon as a tick does something', async () => {
    const { heartbeat, server } = startHealthServer(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      for (let i = 0; i < 6; i++) heartbeat.mark('bench-scorer', 'scored=0', 'idle');
      expect((await drain(port))['status']).toBe('degraded');

      heartbeat.mark('bench-scorer', 'scored=21', 'worked');
      expect((await drain(port))['status']).toBe('up');
    } finally {
      server.close();
    }
  });

  it('stays up through a caught-up queue, however long it stays quiet', async () => {
    // The prober probes every endpoint inside an hour and then has nothing due
    // until the next window; the audition queue has its whole verified-live set
    // inside the re-audition floor. Both used to trip the alert, so a healthy
    // worker read "needs attention" - which is how a signal that had just found
    // three real bugs starts getting ignored.
    const { heartbeat, server } = startHealthServer(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      for (let i = 0; i < 40; i++) heartbeat.mark('bench-prober', 'probed=0', 'nothing-due');
      const body = await drain(port);
      expect(body['status']).toBe('up');
      expect(body['attention']).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('does not let nothing-due ticks hide an unaccounted-for streak', async () => {
    // A queue alternating between "nothing due" and "had candidates, did
    // nothing" is not healthy, and the reset must not launder it. Only an
    // unbroken run of unaccounted-for ticks alerts.
    const { heartbeat, server } = startHealthServer(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      for (let i = 0; i < 4; i++) {
        heartbeat.mark('bench-audition', 'considered=6 auditioned=0 skipped=0', 'idle');
        heartbeat.mark('bench-audition', 'considered=0', 'nothing-due');
      }
      expect((await drain(port))['status']).toBe('up');

      for (let i = 0; i < 5; i++) {
        heartbeat.mark('bench-audition', 'considered=6 auditioned=0 skipped=0', 'idle');
      }
      expect((await drain(port))['status']).toBe('degraded');
    } finally {
      server.close();
    }
  });

  it('leaves a queue that cannot say out of it, rather than assuming it is busy', async () => {
    const { heartbeat, server } = startHealthServer(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      for (let i = 0; i < 10; i++) heartbeat.mark('bench-anchor');
      expect((await drain(port))['status']).toBe('up');
    } finally {
      server.close();
    }
  });
});

describe('health: what the endpoint is willing to say to a stranger', () => {
  const drainRaw = async (port: number, path = '/health'): Promise<Record<string, unknown>> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return (await res.json()) as Record<string, unknown>;
  };

  it('withholds per-queue detail from an unauthenticated caller', async () => {
    // The failure message of a queue is generated by libraries that put
    // connection strings in it - viem embeds the whole archive-node URL, key
    // included. Serving that to anyone made this endpoint a credential
    // disclosure waiting for one RPC hiccup.
    const { heartbeat, server } = startHealthServer(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      heartbeat.fail(
        'bench-audition',
        'HTTP request failed. URL: https://x.quiknode.pro/KEY0000000000000000000/',
      );

      const body = await drainRaw(port);
      expect(body['queues']).toEqual({});
      expect(body['detail']).toBe('withheld');
      // Liveness still answers, so a host healthcheck works without a secret.
      expect(body['status']).toBe('up');
      expect(JSON.stringify(body)).not.toContain('KEY0000000000000000000');
    } finally {
      server.close();
    }
  });

  it('redacts a provider key even from the authenticated view', async () => {
    // Defence in depth: the call site redacts, and so does the store. A caller
    // that forgets is the normal way a secret gets published.
    process.env['BENCH_WORKER_HEALTH_TOKEN'] = 'test-token-value';
    const { heartbeat, server } = startHealthServer(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      heartbeat.fail(
        'bench-audition',
        'URL: https://cold.bsc.quiknode.pro/KEY0000000000000000000/',
      );

      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: 'Bearer test-token-value' },
      });
      const body = (await res.json()) as Record<string, unknown>;

      expect(body['detail']).toBeUndefined();
      const queues = body['queues'] as Record<string, { lastFailure: string }>;
      expect(queues['bench-audition']?.lastFailure).toContain('[redacted]');
      expect(JSON.stringify(body)).not.toContain('KEY0000000000000000000');
      // Still diagnosable.
      expect(queues['bench-audition']?.lastFailure).toContain('quiknode.pro');
    } finally {
      server.close();
      delete process.env['BENCH_WORKER_HEALTH_TOKEN'];
    }
  });
});

describe('health: what the deployment can actually do', () => {
  it('reports the capability that decides whether auditions mean anything', async () => {
    // With no public origin every agent is handed a loopback RPC it cannot
    // reach, so every one measures exactly $0.00 while every queue stays
    // green. That was answerable only from a boot log, which is not reachable
    // from outside the host - so the single most consequential setting in the
    // deployment was invisible.
    const { server } = startHealthServer(0, undefined, () => ({
      auditionRpcPubliclyRoutable: false,
      auditionsEnabled: true,
    }));
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = (await res.json()) as { capabilities?: Record<string, boolean> };
      expect(body.capabilities?.['auditionRpcPubliclyRoutable']).toBe(false);
      expect(body.capabilities?.['auditionsEnabled']).toBe(true);
    } finally {
      server.close();
    }
  });

  it('says so without needing the token, since it names no values', async () => {
    // Deliberately outside the authenticated section: these are booleans about
    // configuration, not the failure messages that carry connection strings.
    const { server } = startHealthServer(0, undefined, () => ({
      auditionRpcPubliclyRoutable: true,
      auditionsEnabled: true,
    }));
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      const body = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
        detail?: string;
        capabilities?: Record<string, boolean>;
      };
      expect(body.detail).toBe('withheld');
      expect(body.capabilities?.['auditionRpcPubliclyRoutable']).toBe(true);
    } finally {
      server.close();
    }
  });
});
