import type { NextConfig } from "next";

/**
 * Warn once, at build time, when the public origin has not been configured.
 *
 * Without it the canonical links, Open Graph images, robots.txt and sitemap
 * a production build emits all point at localhost, which is silently wrong
 * rather than broken. This file is evaluated once per build, unlike the
 * config module itself, which is instantiated in every prerender worker.
 */
function checkSiteUrl() {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.NEXT_PUBLIC_SITE_URL?.trim()) return;
  // Vercel supplies a project's stable production domain; other platforms
  // need NEXT_PUBLIC_SITE_URL set explicitly.
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()) return;
  console.warn(
    "\n  NEXT_PUBLIC_SITE_URL is not set.\n" +
      "  Canonical URLs, Open Graph images, robots.txt and the sitemap will\n" +
      "  point at http://localhost:3000. See .env.example.\n",
  );
}

checkSiteUrl();

const nextConfig: NextConfig = {};

export default nextConfig;
