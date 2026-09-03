import Link from 'next/link';
import { Wordmark } from './Logo';

export function Footer() {
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

        <p className="tiny">
          Built for BNB Chain’s{' '}
          <a href="https://www.bnbchain.org/en/hackathons/smart-money-era">The Smart Money Era</a>{' '}
          hackathon. Testnet only - no real value has touched this deployment. Audition results are
          simulated and labelled as such throughout.
        </p>
      </div>
    </footer>
  );
}
