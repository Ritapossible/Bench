export const usd = (n: number, opts: { sign?: boolean } = {}): string => {
  const s = Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 });
  if (!opts.sign) return n < 0 ? `−${s}` : s;
  return n < 0 ? `−${s}` : `+${s}`;
};

export const pct = (bps: number, dp = 1): string => `${(bps / 100).toFixed(dp)}%`;

export const ms = (n: number | null): string => (n === null ? '—' : `${n} ms`);

export const shortAddr = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export const agentHref = (chain: string, tokenId: bigint): string => `/agents/${chain}/${tokenId.toString()}`;

/** Order matters: the four judged categories lead. */
export const CATEGORY_LABEL: Record<string, string> = {
  rebalancing: 'Rebalancing',
  grid: 'Grid trading',
  yield: 'Yield optimization',
  'health-factor': 'Health factor',
  monitoring: 'Monitoring',
  other: 'Other',
};

export const ago = (d: Date, from: Date = new Date('2026-08-25T12:00:00Z')): string => {
  const mins = Math.round((from.getTime() - d.getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};
