// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/testing.ts"],
      thresholds: { 100: true },
    },
  },
});
