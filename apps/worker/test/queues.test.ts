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
      heartbeat.mark('bench-audition', 'auditioned=2', true);
      expect((await drain(port))['status']).toBe('up');

      // Five consecutive empty ticks: enough to notice within one cadence,
      // more than the single quiet tick that is normal once caught up.
      for (let i = 0; i < 5; i++) heartbeat.mark('bench-audition', 'auditioned=0', false);

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
      for (let i = 0; i < 6; i++) heartbeat.mark('bench-scorer', 'scored=0', false);
      expect((await drain(port))['status']).toBe('degraded');

      heartbeat.mark('bench-scorer', 'scored=21', true);
      expect((await drain(port))['status']).toBe('up');
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
