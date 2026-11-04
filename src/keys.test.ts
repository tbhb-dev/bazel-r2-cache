// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import { describe, expect, it } from "vitest";
import { namespace } from "./keys.ts";

const D = "d".repeat(64);

describe("namespace", () => {
  it.each([
    ["read", "cas", { reads: [`cas/${D}`], write: null }],
    ["main", "cas", { reads: [`cas/${D}`], write: `cas/${D}` }],
    ["pr", "cas", { reads: [`cas/${D}`], write: `cas/${D}` }],
    ["host", "cas", { reads: [`cas/${D}`], write: `cas/${D}` }],
    ["read", "ac", { reads: [`ac/main/${D}`], write: null }],
    ["main", "ac", { reads: [`ac/main/${D}`], write: `ac/main/${D}` }],
    [
      "pr",
      "ac",
      {
        reads: [`ac/pr/o/r/42/${D}`, `ac/main/${D}`],
        write: `ac/pr/o/r/42/${D}`,
      },
    ],
    [
      "host",
      "ac",
      { reads: [`ac/main/${D}`, `ac/host/${D}`], write: `ac/host/${D}` },
    ],
    ["e2e", "cas", { reads: [`e2e/cas/${D}`], write: `e2e/cas/${D}` }],
    ["e2e", "ac", { reads: [`e2e/ac/${D}`], write: `e2e/ac/${D}` }],
  ] as const)("gives %s its %s keys", (role, kind, expected) => {
    expect(namespace(role, kind, D, "o/r/42")).toEqual(expected);
  });

  it("gives a pr role without a pull request main's entries, read-only", () => {
    expect(namespace("pr", "ac", D, null)).toEqual({
      reads: [`ac/main/${D}`],
      write: null,
    });
  });
});
