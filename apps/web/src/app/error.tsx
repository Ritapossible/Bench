'use client';

import { useEffect } from 'react';

/**
 * What a visitor sees when a page throws.
 *
 * Every catalog page renders per request against Postgres, so a database blip,
 * a slow query or an unreachable RPC surfaces here. Without this file Next
 * renders its own unstyled "Application error: a server-side exception has
 * occurred", which during judging is a dead end with no explanation and no way
 * back.
 *
 * The message is deliberately not shown: it is a server error string and can
 * carry connection details. The digest is, because it is the thing that lets an
 * operator find the matching server log.
 */
export default function Error({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    console.error('[bench] page error', error);
  }, [error]);

  return (
    <section className="wrap section">
      <div className="stack stack-16" style={{ maxWidth: '38rem' }}>
        <span className="eyebrow">Something broke</span>
        <h1 className="h2">This page could not be loaded.</h1>
        <p className="lead">
          Bench reads the catalog live from its own database on every request, so this is usually a
          transient failure rather than anything wrong with what you asked for.
        </p>
        <div className="row" style={{ gap: '0.75rem' }}>
          <button className="btn btn-primary" type="button" onClick={reset}>
            Try again
          </button>
          <a className="btn btn-outline" href="/">
            Back to the catalog
          </a>
        </div>
        {error.digest === undefined ? null : (
          <p className="tiny mono break">Reference: {error.digest}</p>
        )}
      </div>
    </section>
  );
}
