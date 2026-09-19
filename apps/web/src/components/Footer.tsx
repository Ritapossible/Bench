import Link from 'next/link';
import { Wordmark } from './Logo';
import { escrowIsReal } from '@/lib/hire/runtime';

/**
 * Where the arbiter can be read, when it is on a chain with a public explorer.
 *
 * Only the Studio chains are mapped, and an unmapped one returns null rather
 * than a guessed host: a footer link to an explorer that does not serve this
 * chain is worse than no link, because it looks checkable and is not.
 */
function explorerUrl(chain: string, address: string): string | null {
  const base =
    chain === 'studio-next' || chain === 'studio-devnet'
      ? 'https://explorer-studio-dev.genlayer.com'
      : null;
  return base === null ? null : `${base}/address/${address}`;
}

function Column({ head, children }: { readonly head: string; readonly children: React.ReactNode }) {
  return (
    <div className="footer-col">
      <h2 className="footer-head">{head}</h2>
      <div className="footer-links">{children}</div>
    </div>
  );
}

export function Footer() {
  // Read here rather than passed in: the footer is on every page, and a prop
  // every layout has to remember to thread is a prop one of them will not.
  const chain = process.env['BENCH_CHAIN'] ?? 'bsc-testnet';
  const settlesOnChain = escrowIsReal();
  const arbiter = process.env['GENLAYER_ARBITER_ADDRESS'] ?? null;
  const glChain = process.env['GENLAYER_CHAIN'] ?? 'studio-next';
  const arbiterUrl = arbiter === null ? null : explorerUrl(glChain, arbiter);

  /*
    The safety claim, derived rather than written down.

    "Testnet only - no real value has touched this deployment" was a literal on
    every page of the site. It is true of this deployment and would have stayed
    on screen unchanged the moment BENCH_ESCROW_ENABLED was flipped or
    BENCH_CHAIN pointed at mainnet - which are one environment variable each,
    and exactly the two changes that make it false. The most consequential
    sentence Bench prints is the one it should least be able to get wrong by
    forgetting to edit it.

    Now four facts instead of one paragraph. Same derivation, and a reader
    scanning for "is this real money" finds it in one line rather than in the
    middle of the fourth sentence.
  */
  const facts: readonly (readonly [string, string])[] = [
    ['Catalog', chain === 'bsc-mainnet' ? 'BNB Smart Chain mainnet' : 'BSC testnet'],
    ['Settlement', settlesOnChain ? 'Real funds, ERC-8183' : 'Simulated, no real value'],
    ['Auditions', 'Forked state, never broadcast'],
    ['Disputes', 'Ruled on GenLayer, not by us'],
  ];

  return (
    <footer className="footer">
      <div className="wrap stack stack-32">
        <div className="footer-top">
          <div className="footer-brand">
            <Wordmark size={30} />
            <p className="small">Every agent starts on the bench.</p>
          </div>

          <Column head="Explore">
            <Link href="/agents">Catalog</Link>
            <Link href="/registry">Registry health</Link>
            <Link href="/report">Your report</Link>
            <Link href="/advantage">Agent advantage</Link>
          </Column>

          <Column head="Project">
            <Link href="/docs">Docs</Link>
            <Link href="/status">Status</Link>
            <a href="https://github.com/Ritapossible/Bench">GitHub ↗</a>
          </Column>

          <Column head="On chain">
            {arbiterUrl === null ? (
              <span className="muted">Arbiter not configured</span>
            ) : (
              <a href={arbiterUrl}>Dispute arbiter ↗</a>
            )}
            <a href="https://www.bnbchain.org/en/hackathons/smart-money-era">
              The Smart Money Era ↗
            </a>
            <a href="https://genlayer.com">GenLayer ↗</a>
          </Column>
        </div>

        <hr className="rule" />

        <div className="footer-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <div className="footer-head">{label}</div>
              <div className="tiny ink">{value}</div>
            </div>
          ))}
        </div>

        <hr className="rule" />

        <p className="tiny footer-fine">
          Built for BNB Chain&rsquo;s The Smart Money Era hackathon. Audition outcomes are measured,
          not estimated.
        </p>
      </div>
    </footer>
  );
}
