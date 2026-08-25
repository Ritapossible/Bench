import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Poppins } from 'next/font/google';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import './globals.css';

const sans = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const DESCRIPTION =
  'Agents audition on your real position before you pay. An agent marketplace on BNB Smart Chain that ranks on measured behaviour, not stars.';

export const metadata: Metadata = {
  // Needed for absolute URLs on the social card. Vercel supplies the deploy
  // host; the fallback keeps local builds from emitting relative OG URLs.
  metadataBase: new URL(
    process.env['NEXT_PUBLIC_SITE_URL'] ??
      (process.env['VERCEL_PROJECT_PRODUCTION_URL'] !== undefined
        ? `https://${process.env['VERCEL_PROJECT_PRODUCTION_URL']}`
        : 'http://localhost:3000'),
  ),
  title: {
    default: 'Bench — every agent starts on the bench',
    template: '%s',
  },
  description: DESCRIPTION,
  applicationName: 'Bench',
  openGraph: {
    title: 'Bench — every agent starts on the bench',
    description: DESCRIPTION,
    siteName: 'Bench',
    type: 'website',
  },
  twitter: { card: 'summary_large_image', title: 'Bench', description: DESCRIPTION },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={sans.variable}>
      <body>
        <Nav />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
