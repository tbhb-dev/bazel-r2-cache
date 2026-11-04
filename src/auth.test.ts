// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import { describe, expect, it } from "vitest";
import { authorize } from "./auth.ts";

const tokens = {
  READ_TOKENS: "reader-a, reader-b",
  HOST_TOKENS: "host-a, host-b",
  MAIN_TOKEN: "main-secret",
  PR_TOKEN: "pr-secret",
  E2E_TOKEN: "e2e-secret",
};

describe("authorize", () => {
  it.each([
    ["main-secret", "main"],
    ["pr-secret", "pr"],
    ["e2e-secret", "e2e"],
    ["reader-a", "read"],
    ["reader-b", "read"],
    ["host-a", "host"],
    ["host-b", "host"],
  ])("gives %s the %s role", async (token, role) => {
    expect(await authorize(`Bearer ${token}`, tokens)).toBe(role);
  });

  it.each([
    ["no header", null],
    ["an unknown token", "Bearer nope"],
    ["a list as one token", "Bearer reader-a, reader-b"],
    ["a read token with its list padding", "Bearer  reader-b"],
    ["a host token with its list padding", "Bearer  host-b"],
    ["another scheme", "Basic main-secret"],
    ["a lowercase scheme", "bearer main-secret"],
    // cspell:ignore Bearermain
    ["no space after the scheme", "Bearermain-secret"],
    ["a bare token", "main-secret"],
  ])("rejects %s", async (_, header) => {
    expect(await authorize(header, tokens)).toBeNull();
  });

  it("never matches an unset secret or an empty list entry", async () => {
    const unset = {
      READ_TOKENS: "reader-a,,",
      HOST_TOKENS: ",host-a,",
      MAIN_TOKEN: "",
      PR_TOKEN: "",
      E2E_TOKEN: "",
    };
    expect(await authorize("Bearer ", unset)).toBeNull();
    expect(await authorize("Bearer reader-a", unset)).toBe("read");
    expect(await authorize("Bearer host-a", unset)).toBe("host");
  });
});
