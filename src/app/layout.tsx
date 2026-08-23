import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

/**
 * `viewport-fit=cover` is what makes env(safe-area-inset-*) report real
 * numbers, which the pane switcher needs to clear an Android gesture bar.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#020617',
};

export const metadata: Metadata = {
  title: 'PAC Tracker — Florida money flows',
  description:
    'Explore how money moves between political committees, candidates and donors in Florida.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* The graph explorer owns the full viewport and manages its own scrolling.
          Height is dvh, not vh: a mobile browser measures vh against the
          viewport it has with the URL bar *hidden*, so a vh-tall page hangs
          below the visible area and the bottom of it — the pane switcher — is
          unreachable until you scroll a page that does not scroll. */}
      <body className="h-dvh overflow-hidden bg-slate-950">{children}</body>
    </html>
  );
}
