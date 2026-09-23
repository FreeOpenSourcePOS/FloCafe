import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import MenuActionHandler from "@/components/layout/MenuActionHandler";
import AuthGuard from "@/components/layout/AuthGuard";
import { HtmlLangSync } from "@/components/layout/HtmlLangSync";
import { ThemeSync } from "@/components/layout/ThemeSync";
import { NumberInputWheelGuard } from "@/components/layout/NumberInputWheelGuard";
import { DirectionalToaster } from "@/components/layout/DirectionalToaster";
import DesktopDragSurface from "@/components/layout/DesktopDragSurface";
import { I18nProvider } from "@/components/providers/I18nProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  // Avoid font preload warnings on standalone routes that initially render without text.
  preload: false,
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  preload: false,
});

export const metadata: Metadata = {
  title: "Flo",
  description: "Smart Point of Sale for restaurants",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Flo",
  },
  icons: {
    icon: [
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#3248FF",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head />
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <I18nProvider>
          <DesktopDragSurface />
          <MenuActionHandler />
          <HtmlLangSync />
          <ThemeSync />
          <NumberInputWheelGuard />
          <AuthGuard>{children}</AuthGuard>
          <DirectionalToaster />
        </I18nProvider>
      </body>
    </html>
  );
}
