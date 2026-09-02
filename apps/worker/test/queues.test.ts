import { describe, expect, it } from 'vitest';
import { QUEUE, redisOptionsFrom } from '../src/queues.js';

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
