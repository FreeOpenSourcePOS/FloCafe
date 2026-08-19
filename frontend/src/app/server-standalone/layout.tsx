import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import '../globals.css';
import { DirectionalToaster } from '@/components/layout/DirectionalToaster';
import { KdsHtmlLang } from '@/components/kds/KdsHtmlLang';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Flo Server App',
  description: 'Tableside ordering for FloCafe',
};

export default function ServerStandaloneLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className="h-full">
      <body className={`${inter.className} h-full bg-slate-50`}>
        <KdsHtmlLang />
        <DirectionalToaster />
        {children}
      </body>
    </html>
  );
}
