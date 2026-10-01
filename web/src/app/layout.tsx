import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import '@/styles/tokens.css';

const sans = IBM_Plex_Sans({ subsets: ['latin', 'latin-ext'], weight: ['400', '500', '600'], variable: '--font-plex-sans', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin', 'latin-ext'], weight: ['400', '500', '600'], variable: '--font-plex-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Estimates AI Agent',
  description: 'Invite-only electrical estimating assistant',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

// Applied before first paint. `eaa-theme-pref` is light | dark | system (Profile); `eaa-theme` is the resolved theme.
const THEME_BOOT = `try{var p=localStorage.getItem('eaa-theme-pref'),t=localStorage.getItem('eaa-theme')||'light';if(p==='system')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';else if(p==='light'||p==='dark')t=p;document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='light'}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
