import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, Syne } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import { SITE_URL } from '@/game/rules';
import './globals.css';

const display = Syne({ subsets: ['latin'], weight: ['600', '800'], variable: '--font-display' });
const body = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-body' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono' });

const description = 'A daily space puzzle. Bend a laser around planets, bounce it off a moon’s mirror and light the beacon. Same puzzle for everyone, every day.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Orbit',
  description,
  // the preview image itself comes from app/opengraph-image.png and twitter-image.png
  openGraph: { title: 'Orbit: a daily light-bending puzzle', description, url: SITE_URL, siteName: 'Orbit', type: 'website' },
  twitter: { card: 'summary_large_image', title: 'Orbit: a daily light-bending puzzle', description },
};
export const viewport: Viewport = { themeColor: '#05060c', viewportFit: 'cover', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
