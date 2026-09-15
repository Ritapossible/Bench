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

const RUNS = [
  {
    name: 'BNB Smart Chain',
    role: 'The registry, the hires, the escrow',
    href: 'https://www.bnbchain.org',
    mark: 'bnb',
  },
  {
    name: 'GenLayer',
    role: 'Rules on disputes, so Bench does not',
    href: 'https://genlayer.com',
    mark: 'genlayer',
  },
] as const;

/** Read or executed on every tick. Nothing here is a stub. */
const ALSO_RUNS = [
  { name: 'ERC-8004', role: 'Identity registry the catalog reads' },
  { name: '8004scan', role: 'Cross-checked against the registry' },
  { name: 'Foundry / anvil', role: 'Forked-mainnet auditions' },
  { name: 'A2A', role: 'Driving agents that speak it' },
  { name: 'MCP', role: 'Driving agents that speak it instead' },
] as const;

/**
 * Interfaces Bench is built against, with stub adapters behind them.
 *
 * **Kept separate, and that separation is the whole point of this component.**
 * A single strip would say Bench integrates these the same way it integrates
 * the registry it reads every thirty seconds, and a reader cannot tell the two
 * apart from a row of chips. An earlier version of this file did exactly that -
 * it listed PancakeSwap and Venus as "positions read and rebalanced" when what
 * exists is the interface and a stub - which is the cheapest kind of dishonesty
 * in a demo and precisely what this catalog exists to catch other people doing.
 */
const DESIGNED_FOR = [
  { name: 'ERC-8183', role: 'Optimistic escrow on a hire' },
  { name: 'Binance x402', role: 'Payment for a hire' },
  { name: 'Altana', role: 'Wallet provider' },
  { name: 'PancakeSwap', role: 'Position type' },
  { name: 'Venus', role: 'Position type' },
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
          {RUNS.map((c) => (
            <a
              key={c.name}
              href={c.href}
              target="_blank"
              rel="noreferrer noopener"
              className="builton-brand"
            >
              {c.mark === 'genlayer' ? <GenLayerMark /> : <BnbMark />}
              <span className="stack stack-4">
                <span className="small ink">{c.name}</span>
                <span className="tiny">{c.role}</span>
              </span>
            </a>
          ))}
        </div>

        <div className="builton-chips">
          {ALSO_RUNS.map((s2) => (
            <span key={s2.name} className="builton-chip" title={s2.role}>
              <span className="mono">{s2.name}</span>
              <span className="tiny">{s2.role}</span>
            </span>
          ))}
        </div>

        <p className="small">
          Everything above runs. The registry is read every tick and cross-checked against 8004scan,
          auditions replay on a fork, and a dispute is ruled on GenLayer by validators none of the
          parties control.
        </p>

        {/*
          Dimmed and labelled, not mixed in. The distinction between what runs
          and what there is an interface for is the one a row of chips destroys.
        */}
        <div className="builton-chips" style={{ opacity: 0.62 }}>
          {DESIGNED_FOR.map((s2) => (
            <span key={s2.name} className="builton-chip" title={s2.role}>
              <span className="mono">{s2.name}</span>
              <span className="tiny">{s2.role}</span>
            </span>
          ))}
        </div>

        <p className="small">
          Behind stub adapters: payment, escrow, the wallet provider and the two position types that
          need them. The rows above are what runs; this is what it is shaped for.
        </p>
      </div>
    </section>
  );
}
