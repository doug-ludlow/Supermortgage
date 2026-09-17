import type { NextConfig } from "next";
import path from "node:path";

// The servicing partner portal (section 36), mounted at /partners beside the borrower app's /app and the
// operator portal's /ops. Standalone output for the container that ships it once the walk is green
// (docs/partner-portal/00-CLAUDE-BUILD-INSTRUCTIONS.md §8 Session 5: no hostname, no Dockerfile.partner yet).
const nextConfig: NextConfig = {
  basePath: "/partners",
  // A build-time override so a test harness can build into its own directory beside .next
  // (src/domain/servicing-partner-portal/36-app.walk.test.ts builds .next-t36 and serves it against its own API); unset → .next.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  output: "standalone",
  // This package has its own lockfile; the repo root has another. Pin the tracing root so the standalone
  // bundle is built from apps/partner alone.
  outputFileTracingRoot: path.resolve(process.cwd()),
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
