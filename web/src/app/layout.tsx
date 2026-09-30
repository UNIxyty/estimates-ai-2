import type { Metadata } from 'next';
import '@/styles/tokens.css';
import { BuildFooter } from '@/components/BuildFooter';

export const metadata: Metadata = {
  title: 'Estimates AI Agent',
  description: 'Invite-only electrical estimating assistant',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <BuildFooter />
      </body>
    </html>
  );
}
