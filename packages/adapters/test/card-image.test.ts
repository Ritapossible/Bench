import { describe, expect, it } from 'vitest';
import { normalizeCard, safeImageUrl } from '../src/catalog/card-resolver.js';

/**
 * The value is a URL a stranger put in an on-chain registration, rendered in a
 * visitor's browser. This registry contains cards whose *name* field is a
 * shell command, so the scheme is allowlisted rather than sanitised.
 */
describe('safeImageUrl', () => {
  it('keeps https', () => {
    expect(safeImageUrl('https://example.com/logo.png')).toBe('https://example.com/logo.png');
  });

  it('keeps an inline data image', () => {
    expect(safeImageUrl('data:image/png;base64,iVBOR')).toBe('data:image/png;base64,iVBOR');
  });

  it('rewrites ipfs and arweave to a gateway', () => {
    expect(safeImageUrl('ipfs://QmHash')).toContain('QmHash');
    expect(safeImageUrl('ipfs://QmHash')?.startsWith('https://')).toBe(true);
    expect(safeImageUrl('ar://TxId')?.startsWith('https://')).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://example.com/logo.png',
    'vbscript:msgbox',
    'file:///etc/passwd',
  ])('drops %s', (bad) => {
    expect(safeImageUrl(bad)).toBeNull();
  });

  it('drops empties, non-strings and absurd lengths', () => {
    expect(safeImageUrl('')).toBeNull();
    expect(safeImageUrl('   ')).toBeNull();
    expect(safeImageUrl(42)).toBeNull();
    expect(safeImageUrl(null)).toBeNull();
    expect(safeImageUrl(`https://e.com/${'a'.repeat(3000)}`)).toBeNull();
  });

  it('drops prose, which is what most of these fields contain', () => {
    expect(safeImageUrl('Mint NFA 100...000')).toBeNull();
  });
});

describe('normalizeCard image', () => {
  const base = { name: 'A', description: 'd' };

  it('carries a usable image through', () => {
    expect(normalizeCard({ ...base, image: 'https://e.com/a.png' }).image).toBe(
      'https://e.com/a.png',
    );
  });

  it('accepts the field names registrations actually use', () => {
    expect(normalizeCard({ ...base, logo: 'https://e.com/l.png' }).image).toBe(
      'https://e.com/l.png',
    );
    expect(normalizeCard({ ...base, avatar: 'https://e.com/v.png' }).image).toBe(
      'https://e.com/v.png',
    );
  });

  it('leaves the property absent rather than undefined when there is none', () => {
    const card = normalizeCard({ ...base, image: '' });
    expect('image' in card).toBe(false);
  });

  it('never lets an unsafe scheme reach the card', () => {
    expect('image' in normalizeCard({ ...base, image: 'javascript:alert(1)' })).toBe(false);
  });
});
