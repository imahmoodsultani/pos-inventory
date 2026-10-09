import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components and Partial Prefetching are Next.js 16 features. `partialPrefetching`
  // is set explicitly because leaving it unset logs a warning (T005).
  cacheComponents: true,
  partialPrefetching: true,

  // `experimental.useOffline` is deliberately ABSENT. It auto-retries Server Actions, which
  // would duplicate sales. See CLAUDE.md § Next.js 16 specifics.

  turbopack: {
    // Pin the root. Without this, Turbopack walks up and may latch onto a stray lockfile
    // outside the repository, which it then warns about and watches.
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
