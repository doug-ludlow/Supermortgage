import { defineConfig } from "vitest/config";
import path from "node:path";

// The unit suite: the formatting helpers (bigint cents, never a number dollar) and the proxy's path allow-list —
// pure modules, so the node environment is enough (no DOM).
export default defineConfig({
  resolve: { alias: { "@": path.resolve(process.cwd()) } },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/lib/**/*.test.ts"],
  },
});
