import type { NextConfig } from "next";
import path from "node:path";

// Mounted at /app on demo.supermortgage.com behind the existing load balancer
// (the ops console keeps `/`). Standalone output feeds Dockerfile.borrower.
const nextConfig: NextConfig = {
  basePath: "/app",
  output: "standalone",
  // This package has its own lockfile; the repo root has another. Pin the
  // tracing root so the standalone bundle is built from apps/borrower alone.
  outputFileTracingRoot: path.resolve(process.cwd()),
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: {
    // `npm run lint` runs tsc --noEmit; keep the build's own check on too.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
