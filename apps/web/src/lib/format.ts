export const usd = (n: number, opts: { sign?: boolean } = {}): string => {
  const s = Math.abs(n).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0,
  });
  if (!opts.sign) return n < 0 ? `−${s}` : s;
  return n < 0 ? `−${s}` : `+${s}`;
};

export const pct = (bps: number, dp = 1): string => `${(bps / 100).toFixed(dp)}%`;

export const ms = (n: number | null): string => (n === null ? '-' : `${n} ms`);

export const shortAddr = (a: string): string =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

export const agentHref = (chain: string, tokenId: bigint): string =>
  `/agents/${chain}/${tokenId.toString()}`;

/** Order matters: the four judged categories lead. */
export const CATEGORY_LABEL: Record<string, string> = {
  rebalancing: 'Rebalancing',
  grid: 'Grid trading',
  yield: 'Yield optimization',
  'health-factor': 'Health factor',
  monitoring: 'Monitoring',
  other: 'Other',
};

/**
 * How long ago, from now.
 *
 * `from` defaulted to a hardcoded `2026-08-25T12:00:00Z`, so every elapsed
 * time on the site was measured against a clock that stopped on the day the
 * line was written. Twelve days later the agent page read "Last probed
 * -17572m ago" - a negative age, on the panel whose entire job is to say how
 * fresh the liveness evidence is. The same shape as the hardcoded BNB price:
 * a constant standing in for something that has to be read at the moment it
 * is used.
 *
 * Still injectable, because a test that pins the clock is worth having; it is
 * the default that had to change.
 */
export const ago = (d: Date, from: Date = new Date()): string => {
  const mins = Math.round((from.getTime() - d.getTime()) / 60_000);
  // A timestamp in the future is a clock disagreement between the worker and
  // the renderer, not a negative age. Reported as just-now rather than as a
  // minus sign nobody can act on.
  if (mins <= 0) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};
