// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.config.mjs" },
  mutate: ["src/**/*.ts", "!src/**/*.test.ts", "!src/testing.ts"],
  concurrency: 2,
  thresholds: { high: 100, low: 100, break: 100 },
  reporters: ["clear-text"],
};
