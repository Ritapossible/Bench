import Link from 'next/link';

/** A real 404 rather than Next's default, which does not look like this site. */
export default function NotFound() {
  return (
    <section className="wrap section">
      <div className="stack stack-16" style={{ maxWidth: '38rem' }}>
        <span className="eyebrow">Not found</span>
        <h1 className="h2">There is nothing here.</h1>
        <p className="lead">
          The agent may not be registered on this chain, or the link may name a token id that was
          never minted.
        </p>
        <div>
          <Link className="btn btn-primary" href="/agents">
            Browse the catalog
          </Link>
        </div>
      </div>
    </section>
  );
}
