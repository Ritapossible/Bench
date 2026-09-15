/**
 * What Bench is actually built on.
 *
 * **Every row here is something the code genuinely drives**, which is the only
 * interesting constraint on a strip like this. A logo wall is the cheapest
 * place in a product to overclaim, and overclaiming is the exact failure this
 * catalog exists to measure in other people's listings. So the roles are
 * specific: not "powered by", but which file talks to it and what for.
 *
 * Two treatments, on purpose. **BNB Chain and GenLayer are brands and get their
 * marks.** The rest are open standards and protocols - ERC-8004, x402, A2A,
 * MCP - and a spec does not have a logo. Inventing one, or tracing a
 * third-party brand badly, would look worse than the wordmark that is actually
 * correct for them.
 */

const CHAINS = [
  {
    name: 'BNB Smart Chain',
    role: 'The registry, the hires, the escrow',
    href: 'https://www.bnbchain.org',
  },
  {
    name: 'GenLayer',
    role: 'Rules on disputes, so Bench does not',
    href: 'https://genlayer.com',
  },
] as const;

/**
 * Ordered by how load-bearing each one is, not alphabetically.
 *
 * ERC-8004 is where every agent in the catalog comes from; Foundry is how the
 * auditions run at all. A reader skimming the first two should come away with
 * the right idea of what this is.
 */
const STACK = [
  { name: 'ERC-8004', role: 'Identity registry the catalog reads' },
  { name: 'Foundry', role: 'Forked-mainnet auditions' },
  { name: 'A2A', role: 'Driving agents that speak it' },
  { name: 'MCP', role: 'Driving agents that speak it instead' },
  { name: 'ERC-8183', role: 'Optimistic escrow on a hire' },
  { name: 'x402', role: 'Payment for a hire' },
  { name: 'PancakeSwap V3', role: 'Positions read and rebalanced' },
  { name: 'Venus', role: 'Lending positions read' },
] as const;

/**
 * The BNB mark, drawn rather than fetched.
 *
 * **Two chevrons and three diamonds**, which is what the mark actually is - a
 * first attempt drew five diamonds, which is the shape people remember rather
 * than the shape Binance uses, and it read as wrong immediately. The top and
 * bottom are angled bars; only the left, centre and right are diamonds.
 *
 * Drawn rather than hotlinked so it stays crisp at any size, costs no request,
 * and cannot rot into a 404. The arms sit at 45 degrees, so each chevron is its
 * outer polyline offset along the perpendicular - which is why the numbers
 * below are the awkward ones rather than round.
 */
function BnbMark() {
  const diamond = (cx: number, cy: number, r: number): string =>
    `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false">
      <g fill="#f0b90b">
        <polygon points="16,2.5 23.5,10 20.32,13.18 16,8.86 11.68,13.18 8.5,10" />
        <polygon points="16,29.5 23.5,22 20.32,18.82 16,23.14 11.68,18.82 8.5,22" />
        <polygon points={diamond(16, 16, 3.6)} />
        <polygon points={diamond(4.6, 16, 3.2)} />
        <polygon points={diamond(27.4, 16, 3.2)} />
      </g>
    </svg>
  );
}

/**
 * The GenLayer mark, painted with `currentColor` through a mask.
 *
 * The supplied asset is a black mark, which would vanish against this page's
 * dark theme. Masking it means the shape comes from the file and the colour
 * comes from the stylesheet, so one asset is correct in both themes and needs
 * no second, inverted copy anyone could forget to update.
 */
function GenLayerMark() {
  return <span className="logomark" aria-hidden="true" />;
}

export function BuiltOn() {
  return (
    <section className="wrap section-tight">
      <div className="stack stack-16">
        <span className="eyebrow">Built on</span>

        <div className="builton-row">
          {CHAINS.map((c) => (
            <a
              key={c.name}
              href={c.href}
              target="_blank"
              rel="noreferrer noopener"
              className="builton-brand"
            >
              {c.name === 'GenLayer' ? <GenLayerMark /> : <BnbMark />}
              <span className="stack stack-4">
                <span className="small ink">{c.name}</span>
                <span className="tiny">{c.role}</span>
              </span>
            </a>
          ))}
        </div>

        <div className="builton-chips">
          {STACK.map((s) => (
            <span key={s.name} className="builton-chip" title={s.role}>
              <span className="mono">{s.name}</span>
              <span className="tiny">{s.role}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
