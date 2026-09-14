import { describe, expect, it } from 'vitest';
import { endpointHost } from '../src/types/agent.js';

/**
 * One parse, shared by the SQL that counts hosts, the page that badges them and
 * the dispute layer that decides whose evidence a document is.
 *
 * Two implementations would disagree on exactly the URLs that matter - a stray
 * port, an uppercase host - and splitting one concentrated platform into
 * several unremarkable ones is the failure that hides what the badge measures.
 */
describe('endpointHost', () => {
  it('reads one host out of a port, a path and a capital letter', () => {
    expect(endpointHost('https://App.Example.org:443/agents/1/card.json')).toBe('app.example.org');
    expect(endpointHost('https://app.example.org/api/mcp')).toBe('app.example.org');
  });

  it('answers null for anything it cannot attribute', () => {
    // Guessing a host from a string shape is how an agent gets credited to
    // somebody else's infrastructure. Absence is the honest answer.
    expect(endpointHost('not a url')).toBeNull();
    expect(endpointHost('')).toBeNull();
    expect(endpointHost(null)).toBeNull();
    expect(endpointHost(undefined)).toBeNull();
  });

  it('does not confuse a host with something that merely contains it', () => {
    // Userinfo before an @ is the classic way to make a URL read as one host
    // and resolve to another.
    expect(endpointHost('https://app.example.org@evil.test/a2a')).toBe('evil.test');
  });
});
