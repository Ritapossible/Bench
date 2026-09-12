'use client';

import { useState } from 'react';

/**
 * The logo a registration published, with initials behind it.
 *
 * Three things make this a client component rather than a bare `<img>`.
 *
 * The URL belongs to a stranger. It has already been scheme-checked at parse
 * time (`safeImageUrl`), but nothing can check that the host is up, that the
 * bytes are an image, or that the file is still there - and on this registry
 * most of them will not be. A broken-image glyph on every other row looks like
 * the catalog is failing, so a failure falls back to initials, which is a
 * worse logo and a better page.
 *
 * `referrerPolicy="no-referrer"` because the host would otherwise learn which
 * Bench page a visitor is reading, and a visitor did not ask to be introduced
 * to a stranger's server to look at a catalog.
 *
 * And no `next/image`: that wants every remote host configured ahead of time,
 * and the hosts here are whatever 345,000 registrations chose.
 */
export function AgentAvatar({
  src,
  name,
  size = 40,
}: {
  readonly src?: string | undefined;
  readonly name: string;
  readonly size?: number;
}) {
  const [failed, setFailed] = useState(false);

  const initials = name
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  const box = {
    width: size,
    height: size,
    minWidth: size,
    borderRadius: size > 48 ? 14 : 10,
  } as const;

  if (src === undefined || src === '' || failed) {
    return (
      <span className="avatar avatar-fallback" style={box} aria-hidden="true">
        {initials === '' ? '?' : initials}
      </span>
    );
  }

  return (
    <img
      className="avatar"
      style={box}
      src={src}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
