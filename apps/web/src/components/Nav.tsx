'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Wordmark } from '@/components/Logo';

const LINKS = [
  ['Catalog', '/agents'],
  ['Your report', '/report'],
  ['Registry health', '/registry'],
  ['Docs', '/docs'],
] as const;

export function Nav() {
  const [open, setOpen] = useState(false);
  const path = usePathname();

  // Close on route change, so tapping a link in the drawer does not leave it
  // open over the page it just navigated to.
  useEffect(() => setOpen(false), [path]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    // Lock the page behind the drawer; scrolling the body under an overlay is
    // the classic mobile-menu bug.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      <header className="nav">
        <div className="wrap nav-inner">
          <Link href="/" className="nav-brand" aria-label="Bench home">
            <Wordmark />
          </Link>

          <nav className="nav-links">
            {LINKS.map(([label, href]) => (
              <Link key={href} href={href} data-active={path === href}>
                {label}
              </Link>
            ))}
          </nav>

          <div className="spacer" />

          <Link href="/report" className="btn btn-primary btn-sm nav-cta">
            Read your report
          </Link>

          <button className="burger" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 7h16M4 12h13M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      {/*
        Deliberately a sibling of <header>, not a child.

        .nav carries `backdrop-filter`, and that makes it the containing block
        for `position: fixed` descendants — so a drawer rendered inside it gets
        clipped to the 4.5rem header box, and its contents spill over the page
        with no background behind them. Same trap as `transform` and `filter`.
      */}
      {open ? (
        <div className="drawer" role="dialog" aria-modal="true" aria-label="Menu">
          <button className="drawer-scrim" aria-label="Close menu" onClick={() => setOpen(false)} />
          <div className="drawer-panel">
            <div className="drawer-head">
              <Wordmark size={22} />
              <button className="burger" onClick={() => setOpen(false)} aria-label="Close menu">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <nav className="drawer-links">
              <Link href="/" data-active={path === '/'}>Home</Link>
              {LINKS.map(([label, href]) => (
                <Link key={href} href={href} data-active={path === href}>
                  {label}
                </Link>
              ))}
              <a href="https://github.com/Ritapossible/Bench">GitHub ↗</a>
            </nav>

            <div className="spacer" />
            <Link href="/report" className="btn btn-primary" style={{ width: '100%' }}>
              Read your report
            </Link>
            <p className="tiny" style={{ marginTop: '0.85rem', textAlign: 'center' }}>
              No wallet needed. Paste any BSC address.
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}
