import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": path.resolve(process.cwd()) } },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/cards/**/*.test.tsx", "tests/lib/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
});
