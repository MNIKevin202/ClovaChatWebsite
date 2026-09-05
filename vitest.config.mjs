import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The application is CommonJS; test files are ESM so they can import vitest.
    include: ["test/**/*.test.mjs"],
    environment: "node",
    testTimeout: 15_000
  }
});
