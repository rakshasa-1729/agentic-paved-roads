// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 5000,
    clearMocks: true,
    setupFiles: ["./tests/setup.ts"],
  },
});
