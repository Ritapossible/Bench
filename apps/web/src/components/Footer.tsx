import Link from 'next/link';
import { Wordmark } from './Logo';
import { escrowIsReal } from '@/lib/hire/runtime';

export function Footer() {
  // Read here rather than passed in: the footer is on every page, and a prop
  // every layout has to remember to thread is a prop one of them will not.
  const chain = process.env['BENCH_CHAIN'] ?? 'bsc-testnet';
  const settlesOnChain = escrowIsReal();

  return (
    <footer className="footer">
      <div className="wrap stack stack-24">
        <div className="stack stack-8" style={{ alignItems: 'center', textAlign: 'center' }}>
          <Wordmark size={30} />
          <p className="small">Every agent starts on the bench.</p>
        </div>

        <hr className="rule" />

        <div className="row-between" style={{ gap: '1rem' }}>
          <div className="row" style={{ gap: '1.25rem' }}>
            <Link href="/agents" className="small" style={{ textDecoration: 'none' }}>
              Catalog
            </Link>
            <Link href="/registry" className="small" style={{ textDecoration: 'none' }}>
              Registry health
            </Link>
            <Link href="/report" className="small" style={{ textDecoration: 'none' }}>
              Your report
            </Link>
            <Link href="/status" className="small" style={{ textDecoration: 'none' }}>
              Status
            </Link>
            <Link href="/docs" className="small" style={{ textDecoration: 'none' }}>
              Docs
            </Link>
          </div>
          <a
            href="https://github.com/Ritapossible/Bench"
            className="small"
            style={{ textDecoration: 'none' }}
          >
            GitHub ↗
          </a>
        </div>

        {/*
          The safety claim, derived rather than written down.

          "Testnet only - no real value has touched this deployment" was a
          literal on every page of the site. It is true of this deployment and
          would have stayed on screen unchanged the moment BENCH_ESCROW_ENABLED
          was flipped or BENCH_CHAIN pointed at mainnet - which are one
          environment variable each, and exactly the two changes that make it
          false. The most consequential sentence Bench prints is the one it
          should least be able to get wrong by forgetting to edit it.
        */}
        <p className="tiny">
          Built for BNB Chain’s{' '}
          <a href="https://www.bnbchain.org/en/hackathons/smart-money-era">The Smart Money Era</a>{' '}
          hackathon.{' '}
          {chain === 'bsc-mainnet'
            ? 'Running against BNB Smart Chain mainnet.'
            : 'Catalog and hires on BSC testnet.'}{' '}
          {settlesOnChain
            ? 'Hire settlement moves real funds through the ERC-8183 kernel.'
            : 'No real value has touched this deployment: hire settlement is simulated.'}{' '}
          Auditions run against forked mainnet state and their transactions are never broadcast; the
          outcomes are measured, not estimated.
        </p>
      </div>
    </footer>
  );
}
