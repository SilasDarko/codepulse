import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./tests/setup.ts"],
    include: [
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
      "tests/failure/**/*.test.ts",
      "tests/benchmark/**/*.test.ts",
    ],
    // Integration/failure tests share one Postgres database and truncate it
    // between tests; running test files in parallel would let one file's
    // TRUNCATE race another file's inserts. Simpler to run files one at a
    // time than to give every file its own database.
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/db/migrations/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
