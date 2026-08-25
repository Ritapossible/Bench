'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Wordmark } from './Logo';
import { ConnectWallet } from './ConnectWallet';

const LINKS = [
  ['Catalog', '/agents'],
  ['Your report', '/report'],
  ['Registry health', '/registry'],
] as const;

export function Nav() {
  const [open, setOpen] = useState(false);
  const path = usePathname();

  return (
    <header className="nav">
      <div className="wrap nav-inner">
        <Link href="/" style={{ textDecoration: 'none' }} aria-label="Bench home">
          <Wordmark />
        </Link>

        <nav className="nav-links" style={{ marginLeft: '2.5rem' }}>
          {LINKS.map(([label, href]) => (
            <Link key={href} href={href} data-active={path === href}>
              {label}
            </Link>
          ))}
        </nav>

        <div className="spacer" />
        <ConnectWallet />

        <button className="burger" onClick={() => setOpen(true)} aria-label="Open menu">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 7h16M4 12h13M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {open ? (
        <div className="drawer">
          <button className="drawer-scrim" aria-label="Close menu" onClick={() => setOpen(false)} />
          <div className="drawer-panel">
            <div className="row-between" style={{ marginBottom: '0.5rem' }}>
              <Wordmark size={22} />
              <button className="burger" onClick={() => setOpen(false)} aria-label="Close menu">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <Link href="/" onClick={() => setOpen(false)}>Home</Link>
            {LINKS.map(([label, href]) => (
              <Link key={href} href={href} onClick={() => setOpen(false)}>
                {label}
              </Link>
            ))}
            <a href="https://github.com/Ritapossible/Bench" onClick={() => setOpen(false)}>Docs</a>
          </div>
        </div>
      ) : null}
    </header>
  );
}
