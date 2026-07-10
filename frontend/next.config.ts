import type { NextConfig } from "next";

/**
 * NEXT_BUILD_MODE=desktop  →  static export for Electron (FloDesktop)
 * NEXT_BUILD_MODE unset    →  standard Next.js server mode (FloPOS cloud)
 */
const isDesktop = process.env.NEXT_BUILD_MODE === "desktop";

const nextConfig: NextConfig = {
  // Static export: required for Electron — served via embedded Express,
  // not file:// so no CORS/routing issues.
  output: isDesktop ? "export" : undefined,

  // Trailing slashes make static paths predictable: /pos → /pos/index.html
  trailingSlash: isDesktop,

  // next/image optimisation requires a running server; disable for static export.
  images: {
    unoptimized: isDesktop,
  },

  // Silence "outside workspace root" warning when Turbopack cannot
  // auto-detect the intended frontend root.
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
