import { describe, expect, it } from 'vitest';
import {
  looksLikeAgentCard,
  resolveA2AServiceUrl,
  serviceUrlFromCard,
} from '../src/agent/a2a-service-url.js';

/**
 * The card and the registration below are verbatim from BSC testnet: agent
 * 1825 registers its A2A service as the well-known card path, and the card
 * there names the real JSON-RPC address. Bench drove the first and recorded
 * `agent returned HTTP 404 to the audition task`.
 */
const CARD_URL = 'https://proofera-lp.tangvu.dev/.well-known/agent-card.json';
const CARD = JSON.stringify({
  name: 'ProofEra LP Risk Evidence Agent',
  url: 'https://proofera-lp.tangvu.dev/',
  preferredTransport: 'JSONRPC',
  protocolVersion: '0.3.0',
});

describe('looksLikeAgentCard', () => {
  it('recognises the shapes registrations actually use', () => {
    expect(looksLikeAgentCard(CARD_URL)).toBe(true);
    expect(looksLikeAgentCard('https://agent.mcpbox.dev/.well-known/agent.json')).toBe(true);
    expect(looksLikeAgentCard('https://x.example/cards/mine.json')).toBe(true);
  });

  it('leaves a service endpoint alone', () => {
    expect(looksLikeAgentCard('https://proofera-lp.tangvu.dev/')).toBe(false);
    expect(looksLikeAgentCard('https://x.example/a2a')).toBe(false);
    expect(looksLikeAgentCard('not a url')).toBe(false);
  });
});

describe('serviceUrlFromCard', () => {
  it('reads the service address out of a real card', () => {
    expect(serviceUrlFromCard(CARD, CARD_URL)).toBe('https://proofera-lp.tangvu.dev/');
  });

  it('resolves a relative url against the card', () => {
    expect(serviceUrlFromCard(JSON.stringify({ url: '/rpc' }), CARD_URL)).toBe(
      'https://proofera-lp.tangvu.dev/rpc',
    );
  });

  it('prefers an explicit JSONRPC interface over the bare url', () => {
    const card = JSON.stringify({
      url: 'https://x.example/grpc',
      additionalInterfaces: [
        { transport: 'GRPC', url: 'https://x.example/grpc' },
        { transport: 'JSONRPC', url: 'https://x.example/rpc' },
      ],
    });
    expect(serviceUrlFromCard(card, CARD_URL)).toBe('https://x.example/rpc');
  });

  it('refuses a transport this driver cannot speak', () => {
    // Handing grpc:// to fetch fails as a network error, which reads as a dead
    // agent rather than as one Bench has no client for.
    expect(serviceUrlFromCard(JSON.stringify({ url: 'grpc://x.example' }), CARD_URL)).toBeNull();
    expect(serviceUrlFromCard('<html>', CARD_URL)).toBeNull();
    expect(serviceUrlFromCard(JSON.stringify([1, 2]), CARD_URL)).toBeNull();
  });

  it('keeps a loopback address rather than hiding it', () => {
    // Agent 1597 publishes exactly this. It is undrivable by anyone, and that
    // is a finding: safeFetch refuses it by name, where dropping it here would
    // send the audition back to the card and report a 405 instead.
    expect(serviceUrlFromCard(JSON.stringify({ url: 'http://localhost:9000/' }), CARD_URL)).toBe(
      'http://localhost:9000/',
    );
  });
});

describe('resolveA2AServiceUrl', () => {
  const fetchOk = (body: string, status = 200) =>
    (async () => ({
      status,
      body,
      latencyMs: 1,
      truncated: false,
      headers: {},
      url: CARD_URL,
    })) as never;

  it('follows a card-shaped endpoint to the service', async () => {
    await expect(resolveA2AServiceUrl(CARD_URL, { fetchImpl: fetchOk(CARD) })).resolves.toBe(
      'https://proofera-lp.tangvu.dev/',
    );
  });

  it('drives a service endpoint unchanged when the GET is not a card', async () => {
    // The endpoint is asked either way - a shape test guessed `/card` wrong
    // and published a 404 about a working agent - but an answer that is not a
    // card changes nothing about where the task is sent.
    await expect(
      resolveA2AServiceUrl('https://proofera-lp.tangvu.dev/', {
        fetchImpl: fetchOk('method not allowed', 405),
      }),
    ).resolves.toBe('https://proofera-lp.tangvu.dev/');
  });

  it('follows a card at a path no shape test would have guessed', async () => {
    // Two registrations in the catalog point at exactly this, and the service
    // they name is one path segment up.
    const url = 'https://api.bortagent.xyz/api/a2a/11168/card';
    await expect(
      resolveA2AServiceUrl(url, {
        fetchImpl: fetchOk('{"url":"https://api.bortagent.xyz/api/a2a/11168"}'),
      }),
    ).resolves.toBe('https://api.bortagent.xyz/api/a2a/11168');
  });

  it('drives the registered url when the card cannot be read', async () => {
    // Whatever the registered URL answers is a measurement; guessing a service
    // address from a card that would not load would not be.
    await expect(resolveA2AServiceUrl(CARD_URL, { fetchImpl: fetchOk('', 500) })).resolves.toBe(
      CARD_URL,
    );
    await expect(
      resolveA2AServiceUrl(CARD_URL, { fetchImpl: fetchOk('{"name":"no url here"}') }),
    ).resolves.toBe(CARD_URL);
    const boom = (async () => {
      throw new Error('dns');
    }) as never;
    await expect(resolveA2AServiceUrl(CARD_URL, { fetchImpl: boom })).resolves.toBe(CARD_URL);
  });
});
