import type { Metadata, Viewport } from 'next';
// IBM Plex is bundled from npm (@fontsource) so builds never need the network for fonts.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@/styles/tokens.css';

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
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
