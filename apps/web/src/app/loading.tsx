/**
 * Shown while a page's data is being fetched.
 *
 * These pages are server-rendered per request against Postgres and, for the
 * report, against BSC. Without this the browser sits on the previous page with
 * no feedback for the duration - which reads as a broken link rather than as
 * work in progress.
 */
export default function Loading() {
  return (
    <section className="wrap section">
      <div className="stack stack-16" style={{ maxWidth: '38rem' }}>
        <span className="eyebrow">Loading</span>
        <p className="lead">Reading the catalog…</p>
      </div>
    </section>
  );
}
