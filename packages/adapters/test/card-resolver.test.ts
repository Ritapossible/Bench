import { BenchError } from '@bench/core';
import { describe, expect, it } from 'vitest';
import {
  CardResolver,
  inferCategory,
  normalizeCard,
  toFetchableUrl,
} from '../src/catalog/card-resolver.js';

/**
 * Agent cards are attacker-controlled and mostly broken: only ~4% of BSC
 * registrations produce a usable one. The resolver's job is to extract what it
 * can from the shapes that appear in practice, and to fail with a *reason*
 * everywhere else — the reasons are the evidence behind the catalog-density
 * number Bench publishes.
 */
describe('toFetchableUrl', () => {
  it('rewrites ipfs:// through the gateway', () => {
    expect(toFetchableUrl('ipfs://QmAbc')).toBe('https://ipfs.io/ipfs/QmAbc');
  });

  it('tolerates the redundant ipfs://ipfs/ prefix seen in the wild', () => {
    expect(toFetchableUrl('ipfs://ipfs/QmAbc')).toBe('https://ipfs.io/ipfs/QmAbc');
  });

  it('rewrites ar:// through the arweave gateway', () => {
    expect(toFetchableUrl('ar://txid')).toBe('https://arweave.net/txid');
  });

  it('honours a custom gateway, for when the default rate-limits a backfill', () => {
    expect(toFetchableUrl('ipfs://QmAbc', { ipfsGateway: 'https://cf.example/ipfs/' })).toBe(
      'https://cf.example/ipfs/QmAbc',
    );
  });

  it('passes https through untouched', () => {
    expect(toFetchableUrl('https://a.example/card.json')).toBe('https://a.example/card.json');
  });
});

describe('normalizeCard', () => {
  it('accepts the A2A shape: bare url plus capabilities', () => {
    const card = normalizeCard({
      name: 'LP Rebalancer',
      description: 'Keeps a PancakeSwap position in range',
      url: 'https://agent.example.com/a2a',
      capabilities: { streaming: true },
    });
    expect(card.name).toBe('LP Rebalancer');
    expect(card.endpoints).toEqual([{ protocol: 'a2a', url: 'https://agent.example.com/a2a' }]);
    expect(card.category).toBe('yield');
  });

  it('reads the services shape real ERC-8004 cards actually use', () => {
    // Verbatim shape from token 2012 of the registry on BSC testnet. The
    // protocol is in `name`, and the array is `services`, not `endpoints`.
    // Reading only `protocol`/`type` parsed every real card to zero endpoints,
    // which made the whole catalog unprobeable - nothing to probe means nothing
    // can ever be verified live.
    const card = normalizeCard({
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: 'Venus Health Factor Monitor',
      description: "Reads a wallet's Venus lending position and returns its health factor.",
      category: 'health-factor-monitoring',
      services: [
        { name: 'a2a', endpoint: 'https://agensea-health-factor.vercel.app/a2a' },
        { name: 'x402', endpoint: 'https://agensea-health-factor.vercel.app/x402' },
        { name: 'erc8183', endpoint: 'onchain:AgenticCommerce.submit' },
      ],
      x402Support: true,
      active: true,
    });

    // The a2a service is kept; x402 and erc8183 are not agent-interaction
    // protocols the prober can conformance-check, so admitting them would
    // inflate "verified live" with endpoints nothing ever verified.
    expect(card.endpoints).toEqual([
      { protocol: 'a2a', url: 'https://agensea-health-factor.vercel.app/a2a' },
    ]);
  });

  it('keeps an agent with no probeable service rather than inventing one', () => {
    // Common in the wild: a card whose only service is a website. It is a real
    // agent and belongs in the catalog; it simply cannot be probed, and the
    // verified-live filter is what says so.
    const card = normalizeCard({
      name: 'Pancake Ranger',
      description: 'PancakeSwap V3 concentrated-liquidity manager for WBNB/USDT.',
      services: [{ endpoint: 'https://github.com/example/suite', name: 'web' }],
    });
    expect(card.name).toBe('Pancake Ranger');
    expect(card.endpoints).toEqual([]);
  });

  it('accepts an endpoints array', () => {
    const card = normalizeCard({
      name: 'x',
      endpoints: [
        { protocol: 'mcp', url: 'https://a.example/mcp' },
        { protocol: 'a2a', url: 'https://a.example/a2a' },
      ],
    });
    expect(card.endpoints).toHaveLength(2);
  });

  it('accepts an endpoints map keyed by protocol', () => {
    const card = normalizeCard({ name: 'x', endpoints: { mcp: 'https://a.example/mcp' } });
    expect(card.endpoints).toEqual([{ protocol: 'mcp', url: 'https://a.example/mcp' }]);
  });

  it('de-duplicates the same URL declared twice', () => {
    const card = normalizeCard({
      name: 'x',
      url: 'https://a.example/a2a',
      endpoints: [{ protocol: 'a2a', url: 'https://a.example/a2a' }],
    });
    expect(card.endpoints).toHaveLength(1);
  });

  it('rejects a card with no name — there is nothing to list', () => {
    expect(() => normalizeCard({ description: 'anonymous' })).toThrow(BenchError);
  });

  it('keeps the original document so a better parser can re-mine it later', () => {
    const raw = { name: 'x', somethingWeDoNotParseYet: 42 };
    expect(normalizeCard(raw).raw).toEqual(raw);
  });

  it('treats an unparseable allowlist as deny-all, never allow-all', () => {
    // Permissions seed the session-key contract allowlist at checkout. Failing
    // open here would hand a hired agent broader authority than it declared.
    const card = normalizeCard({ name: 'x', permissions: { contractAllowlist: 'not-an-array' } });
    expect(card.permissions.contractAllowlist).toEqual([]);
  });

  it('keeps only well-formed addresses from the allowlist', () => {
    const good = '0x1111111111111111111111111111111111111111';
    const card = normalizeCard({
      name: 'x',
      permissions: { contractAllowlist: [good, 'nonsense', 42] },
    });
    expect(card.permissions.contractAllowlist).toEqual([good]);
  });

  it('parses an attestation when both fields are present', () => {
    const card = normalizeCard({ name: 'x', attestation: { kind: 'tee', ref: 'https://a/quote' } });
    expect(card.attestation).toEqual({ kind: 'tee', ref: 'https://a/quote' });
  });

  it('omits a half-specified attestation rather than inventing one', () => {
    expect(normalizeCard({ name: 'x', attestation: { kind: 'tee' } }).attestation).toBeUndefined();
  });
});

describe('inferCategory', () => {
  it('prefers an explicit declaration over inference', () => {
    expect(inferCategory({ category: 'monitoring' }, 'Yield Farmer', 'farms yield')).toBe(
      'monitoring',
    );
  });

  it('reads health-factor as more specific than yield', () => {
    // A liquidation-protection agent also talks about lending; the more
    // specific signal has to win or it gets scored with the wrong primitive.
    expect(inferCategory({}, 'Venus Guard', 'avoids liquidation on lending positions')).toBe(
      'health-factor',
    );
  });

  it('infers from skills as well as name and description', () => {
    expect(inferCategory({ skills: [{ name: 'grid trading' }] }, 'Bot', '')).toBe('grid');
  });

  it('falls back to other rather than guessing', () => {
    // 'other' agents are listed and probed but never handed a fabricated
    // performance score — see ARCHITECTURE.md section 5.
    expect(inferCategory({}, 'Mystery Agent', 'does things')).toBe('other');
  });
});

describe('CardResolver', () => {
  it('reads an inline data: URI with no network at all', async () => {
    const json = JSON.stringify({ name: 'Inline', url: 'https://a.example/a2a' });
    const card = await new CardResolver().resolve(
      `data:application/json,${encodeURIComponent(json)}`,
    );
    expect(card.name).toBe('Inline');
  });

  it('reads a base64 data: URI', async () => {
    const json = JSON.stringify({ name: 'B64' });
    const b64 = Buffer.from(json, 'utf8').toString('base64');
    const card = await new CardResolver().resolve(`data:application/json;base64,${b64}`);
    expect(card.name).toBe('B64');
  });

  it('reports non-JSON with a specific reason', async () => {
    await expect(new CardResolver().resolve('data:text/plain,hello%20world')).rejects.toThrow(
      /not JSON/,
    );
  });

  it('rejects a JSON array — a card must be an object', async () => {
    await expect(new CardResolver().resolve('data:application/json,%5B%5D')).rejects.toThrow(
      /not a JSON object/,
    );
  });
});
