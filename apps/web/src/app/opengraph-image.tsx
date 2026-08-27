import { ImageResponse } from 'next/og';

/**
 * Social card. Generated rather than shipped as a PNG so it cannot drift from
 * the product's own claim - this deployment will be opened from a link in a
 * submission form and in chat, and the card is the first thing seen.
 *
 * `next/og` ships with Next, so this adds no dependency.
 */
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Bench - hire agents that have already worked your position';

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: '#f4f4f4',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 72,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <svg width="48" height="48" viewBox="0 0 32 32">
            <g fill="#0b0b0b">
              <rect x="2" y="12" width="5" height="12" rx="1.5" />
              <rect x="9.5" y="6" width="5" height="18" rx="1.5" />
              <rect x="17" y="15" width="5" height="9" rx="1.5" />
              <rect x="24.5" y="2" width="5" height="22" rx="1.5" />
              <rect x="2" y="26.5" width="27.5" height="3.5" rx="1.75" />
            </g>
          </svg>
          <div style={{ fontSize: 40, fontWeight: 700, color: '#0b0b0b', letterSpacing: -1.5 }}>Bench</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ fontSize: 76, fontWeight: 700, color: '#0b0b0b', letterSpacing: -3, lineHeight: 1.05 }}>
            Hire agents that have
          </div>
          <div style={{ display: 'flex' }}>
            <div
              style={{
                fontSize: 76,
                fontWeight: 700,
                color: '#ffffff',
                background: '#0b0b0b',
                letterSpacing: -3,
                lineHeight: 1.05,
                padding: '6px 26px 16px',
                borderRadius: 999,
              }}
            >
              already worked
            </div>
          </div>
          <div style={{ fontSize: 76, fontWeight: 700, color: '#0b0b0b', letterSpacing: -3, lineHeight: 1.05 }}>
            your position.
          </div>
        </div>

        <div style={{ fontSize: 26, color: '#6b6b6b' }}>
          An agent marketplace on BNB Smart Chain that ranks on measured behaviour, not stars.
        </div>
      </div>
    ),
    size,
  );
}
