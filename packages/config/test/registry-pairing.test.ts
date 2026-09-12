import { describe, expect, it } from 'vitest';
import { KNOWN_IDENTITY_REGISTRY, registryMismatch } from '../src/index.js';

/**
 * Not a hypothetical mix-up. The testnet registry address also exists on BSC
 * mainnet, as an EIP-1967 proxy whose implementation is uninitialized, so a
 * mainnet deployment pointed at it indexes an empty registry and reports zero
 * agents rather than failing - a working-looking deployment of a dead
 * ecosystem.
 */
describe('registryMismatch', () => {
  it('refuses the testnet registry on mainnet, naming the address to use', () => {
    const problem = registryMismatch('bsc-mainnet', KNOWN_IDENTITY_REGISTRY['bsc-testnet']);
    expect(problem).toContain(KNOWN_IDENTITY_REGISTRY['bsc-mainnet']);
    expect(problem).toContain('bsc-testnet registry');
  });

  it('refuses the mainnet registry on testnet', () => {
    const problem = registryMismatch('bsc-testnet', KNOWN_IDENTITY_REGISTRY['bsc-mainnet']);
    expect(problem).toContain('bsc-mainnet registry');
  });

  it('accepts each chain paired with its own registry', () => {
    for (const chain of ['bsc-mainnet', 'bsc-testnet'] as const) {
      expect(registryMismatch(chain, KNOWN_IDENTITY_REGISTRY[chain])).toBeNull();
    }
  });

  it('is case-insensitive, since these addresses are written checksummed and not', () => {
    expect(
      registryMismatch('bsc-mainnet', KNOWN_IDENTITY_REGISTRY['bsc-mainnet'].toUpperCase()),
    ).toBeNull();
  });

  it('allows an unknown address, so a fork or successor contract still works', () => {
    expect(
      registryMismatch('bsc-mainnet', '0x1111111111111111111111111111111111111111'),
    ).toBeNull();
  });

  it('keeps the two known addresses distinct', () => {
    expect(KNOWN_IDENTITY_REGISTRY['bsc-mainnet'].toLowerCase()).not.toBe(
      KNOWN_IDENTITY_REGISTRY['bsc-testnet'].toLowerCase(),
    );
  });
});
