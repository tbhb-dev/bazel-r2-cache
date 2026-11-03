// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import { describe, expect, it } from "vitest";
import { authorize } from "./auth.ts";

const tokens = { READ_TOKEN: "read-secret", WRITE_TOKEN: "write-secret" };

describe("authorize", () => {
  it("gives the write role for the write token", async () => {
    expect(await authorize("Bearer write-secret", tokens)).toBe("write");
  });

  it("gives the read role for the read token", async () => {
    expect(await authorize("Bearer read-secret", tokens)).toBe("read");
  });

  it("prefers write when both secrets are the same", async () => {
    const same = { READ_TOKEN: "one", WRITE_TOKEN: "one" };
    expect(await authorize("Bearer one", same)).toBe("write");
  });

  it.each([
    ["no header", null],
    ["an unknown token", "Bearer nope"],
    ["another scheme", "Basic write-secret"],
    ["a lowercase scheme", "bearer write-secret"],
    ["no space after the scheme", "Bearerwrite-secret"],
    ["a bare token", "write-secret"],
  ])("rejects %s", async (_, header) => {
    expect(await authorize(header, tokens)).toBeNull();
  });

  it("never matches an unset secret", async () => {
    expect(
      await authorize("Bearer ", { READ_TOKEN: "", WRITE_TOKEN: "" }),
    ).toBeNull();
  });
});
