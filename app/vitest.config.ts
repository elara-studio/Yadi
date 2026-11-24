import { defineConfig } from "vitest/config";

// Standalone config (no React plugin): esbuild handles TSX through tsconfig's "react-jsx".
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    globals: false,
  },
});
