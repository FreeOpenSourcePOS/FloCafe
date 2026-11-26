import type { Metadata } from 'next';
import '../globals.css';
import { KdsHtmlLang } from '@/components/kds/KdsHtmlLang';

export const metadata: Metadata = {
  title: 'Flo KDS - Kitchen Display',
  description: 'Kitchen Display System',
  // The root manifest starts at /dashboard, which the KDS server cannot back.
  manifest: '/kds-manifest.json',
};

export default function KdsStandaloneLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen h-full flex flex-col p-4 bg-muted">
      <KdsHtmlLang />
      {children}
    </div>
  );
}
