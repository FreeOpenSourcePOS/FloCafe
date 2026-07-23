import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import '../globals.css';
import { Toaster } from 'react-hot-toast';
import { KdsHtmlLang } from '@/components/kds/KdsHtmlLang';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Flo KDS - Kitchen Display',
  description: 'Kitchen Display System',
};

export default function KdsStandaloneLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className="h-full">
      <body className={`${inter.className} h-full bg-gray-100`}>
        <KdsHtmlLang />
        <Toaster position="top-right" />
        <div className="h-full flex flex-col p-4">
          {children}
        </div>
      </body>
    </html>
  );
}
