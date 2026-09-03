import { describe, expect, it } from 'vitest';
import { redactError, redactSecrets } from '../src/redact.js';

describe('redactSecrets', () => {
  it('strips a provider key out of the path of an RPC URL', () => {
    // The exact shape viem produces. This message travelled from a failed tick
    // into the worker heartbeat, out of an unauthenticated /health, and onto
    // the public status page - so a paid archive key was one RPC hiccup from
    // being published.
    const viem =
      'HTTP request failed.\n\nURL: https://cold-x.bsc.quiknode.pro/abc123def456ghi789jkl012/\n' +
      'Request body: {"method":"eth_blockNumber"}\n\nDetails: fetch failed\nVersion: viem@2.21.55';

    const out = redactSecrets(viem, 1_000);

    expect(out).not.toContain('abc123def456ghi789jkl012');
    expect(out).toContain('[redacted]');
    // Still diagnosable: the host and the failure survive.
    expect(out).toContain('cold-x.bsc.quiknode.pro');
    expect(out).toContain('eth_blockNumber');
  });

  it('strips the password out of a Postgres or Redis URL', () => {
    const out = redactSecrets(
      'connect ECONNREFUSED redis://default:hunter2@redis.internal:6379',
      1_000,
    );
    expect(out).not.toContain('hunter2');
    expect(out).toContain('redis.internal');
  });

  it('strips secret query parameters by name', () => {
    const out = redactSecrets(
      'GET https://api.example.com/v1/agents?apiKey=SUPERSECRETVALUE&chain=56',
      1_000,
    );
    expect(out).not.toContain('SUPERSECRETVALUE');
    expect(out).toContain('chain=56');
  });

  it('leaves a public address alone', () => {
    // Addresses are identifiers, not secrets, and redacting them would make
    // every failure message useless for finding the agent it was about.
    const addr = '0x55d398326f99059ff775485246999027b3197955';
    expect(redactSecrets(`agent ${addr} returned HTTP 404`, 1_000)).toContain(addr);
  });

  it('strips a long hex blob, which is the shape of a key', () => {
    const key = `0x${'ab'.repeat(32)}`;
    expect(redactSecrets(`signing failed with ${key}`, 1_000)).not.toContain(key);
  });

  it('strips a value it was told is secret, whatever shape it has', () => {
    process.env['ALTLAYER_8004SCAN_API_KEY'] = 'short-but-secret';
    try {
      expect(redactSecrets('401 for key short-but-secret', 1_000)).not.toContain(
        'short-but-secret',
      );
    } finally {
      delete process.env['ALTLAYER_8004SCAN_API_KEY'];
    }
  });

  it('bounds the result, and redacts before truncating', () => {
    // Order matters: truncating first would let a secret survive by sitting
    // past the cut in a message that was then stored whole elsewhere.
    const long = `${'x'.repeat(400)} https://n.example/verylongopaquekeysegment0000/`;
    const out = redactSecrets(long, 50);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out).not.toContain('verylongopaquekeysegment0000');
  });

  it('handles a non-Error throw without losing the redaction', () => {
    expect(redactError('failed at https://x.quiknode.pro/keykeykeykeykeykeykey1/')).not.toContain(
      'keykeykeykeykeykeykey1',
    );
  });
});
