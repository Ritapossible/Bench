'use client';

import { useState } from 'react';

const NAV = [
  ['Catalog', '/agents'],
  ['Your report', '/report'],
  ['Registry health', '/registry'],
];

/**
 * Wallet connection is deliberately not wired yet.
 *
 * Per ARCHITECTURE.md §3.8 nothing a visitor needs before hiring requires a
 * signature — the catalog, the audition reports and the registry dashboard are
 * all public. Hiring arrives in Phase 4, and RainbowKit drops in behind this
 * component without touching a caller.
 *
 * The button stays visible because it tells a visitor what the product will do;
 * it says so honestly rather than opening a modal that cannot finish.
 */
export function ConnectWallet() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Connect Wallet
      </button>

      {open ? (
        <div className="drawer" role="dialog" aria-modal="true" aria-label="Connect wallet">
          <button className="drawer-scrim" aria-label="Close" onClick={() => setOpen(false)} />
          <div
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 0,
              transform: 'translateX(-50%)',
              width: 'min(30rem, 100%)',
              background: 'var(--ink)',
              color: 'var(--ink-inverse)',
              borderRadius: 'var(--r-lg) var(--r-lg) 0 0',
              padding: '2rem var(--pad) 2.5rem',
            }}
            className="on-dark stack stack-16"
          >
            <div className="row-between">
              <h3 className="h3">Nothing here needs a wallet yet</h3>
              <button className="btn btn-ghost btn-sm on-dark" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <p className="body">
              Connecting is for <strong style={{ color: 'inherit' }}>hiring</strong>, which lands in Phase 4 with
              escrow and a capped session key. Everything that tells you whether an agent is worth hiring is public:
              paste any BSC address and read the audition report.
            </p>
            <div className="stack stack-8">
              {NAV.map(([label, href]) => (
                <a key={href} href={href} className="btn btn-primary" style={{ width: '100%' }}>
                  {label}
                </a>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
