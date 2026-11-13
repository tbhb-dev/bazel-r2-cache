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
  REPO_MAIN_TOKENS: "Org-A/Repo-One=one-secret, org-a/repo-two=two-secret",
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
    expect(await authorize(`Bearer ${token}`, tokens)).toEqual({
      role,
      repo: null,
    });
  });

  it.each([
    ["one-secret", "org-a/repo-one"],
    ["two-secret", "org-a/repo-two"],
  ])("binds %s to %s as a main token", async (token, repo) => {
    expect(await authorize(`Bearer ${token}`, tokens)).toEqual({
      role: "main",
      repo,
    });
  });

  it.each([
    ["no repository", "=t1"],
    ["no token", "tbhb-dev/a="],
    ["a blank token", "tbhb-dev/a=  "],
    ["no equals sign", "tbhb-dev/a"],
    ["a repository with no owner", "a=t1"],
    ["a dot repository", "tbhb-dev/.=t1"],
    ["a dot-dot repository", "tbhb-dev/..=t1"],
    ["a dot-dot repository with padding", "tbhb-dev/.. = t1"],
    ["a three-part repository", "tbhb-dev/a/b=t1"],
    ["an owner starting with a dash", "-x/a=t1"],
    ["an owner of 40 characters", `${"a".repeat(40)}/a=t1`],
    ["a repository of 101 characters", `tbhb-dev/${"a".repeat(101)}=t1`],
    ["a token with a space in it", "tbhb-dev/a=t 1"],
    ["a repository with a space in it", "tbhb-dev/a b=t1"],
  ])("never matches a repository token entry with %s", async (_, entry) => {
    const bad = { ...tokens, REPO_MAIN_TOKENS: entry };
    expect(await authorize("Bearer t1", bad)).toBeNull();
    expect(await authorize("Bearer t 1", bad)).toBeNull();
    expect(await authorize("Bearer t", bad)).toBeNull();
    expect(await authorize("Bearer ", bad)).toBeNull();
  });

  it("accepts the longest owner and repository, a dotted name and padding", async () => {
    const owner = "a".repeat(39);
    const repo = `.${"b".repeat(99)}`;
    const ok = {
      ...tokens,
      REPO_MAIN_TOKENS: `${owner.toUpperCase()}/${repo} = t1 , x/..a=t2`,
    };
    expect(await authorize("Bearer t1", ok)).toEqual({
      role: "main",
      repo: `${owner}/${repo}`,
    });
    expect(await authorize("Bearer t2", ok)).toEqual({
      role: "main",
      repo: "x/..a",
    });
  });

  it("keeps a repository token's list entries apart", async () => {
    const two = { ...tokens, REPO_MAIN_TOKENS: "o/a=t1,o/b=t2,bad,,o/c=t3" };
    expect(await authorize("Bearer t1", two)).toMatchObject({ repo: "o/a" });
    expect(await authorize("Bearer t2", two)).toMatchObject({ repo: "o/b" });
    expect(await authorize("Bearer t3", two)).toMatchObject({ repo: "o/c" });
    expect(await authorize("Bearer t1,o/b=t2", two)).toBeNull();
    expect(await authorize("Bearer t", two)).toBeNull();
  });

  it("refuses a token that a repository entry shares with another owner", async () => {
    const shared = {
      ...tokens,
      REPO_MAIN_TOKENS:
        "o/a=main-secret,o/b=dup,o/c=dup,o/d=pr-secret,o/e=reader-a,o/f=ok,o/f=ok",
    };
    for (const token of ["main-secret", "dup", "pr-secret", "reader-a"]) {
      expect(await authorize(`Bearer ${token}`, shared)).toBeNull();
    }
    expect(await authorize("Bearer ok", shared)).toEqual({
      role: "main",
      repo: "o/f",
    });
    expect(await authorize("Bearer host-a", shared)).toEqual({
      role: "host",
      repo: null,
    });
  });

  it("refuses a token that two roles share", async () => {
    const shared = {
      ...tokens,
      PR_TOKEN: "main-secret",
      E2E_TOKEN: "host-b",
      READ_TOKENS: "reader-a, host-a",
    };
    for (const token of ["main-secret", "host-b", "host-a"]) {
      expect(await authorize(`Bearer ${token}`, shared)).toBeNull();
    }
    expect(await authorize("Bearer reader-a", shared)).toEqual({
      role: "read",
      repo: null,
    });
  });

  it("refuses a repository token that an e2e or host token shares", async () => {
    const shared = {
      ...tokens,
      REPO_MAIN_TOKENS: "o/a=e2e-secret,o/b=host-a",
    };
    expect(await authorize("Bearer e2e-secret", shared)).toBeNull();
    expect(await authorize("Bearer host-a", shared)).toBeNull();
  });

  it("matches a repository listed twice in different case with one token", async () => {
    const twice = { ...tokens, REPO_MAIN_TOKENS: "O/A=t1,o/a=t1" };
    expect(await authorize("Bearer t1", twice)).toEqual({
      role: "main",
      repo: "o/a",
    });
  });

  it("matches a role listed twice with one token", async () => {
    const twice = { ...tokens, READ_TOKENS: "reader-a, reader-a" };
    expect(await authorize("Bearer reader-a", twice)).toEqual({
      role: "read",
      repo: null,
    });
  });

  it.each(["MAIN_TOKEN", "PR_TOKEN", "E2E_TOKEN"] as const)(
    "never matches an empty or whitespace-only %s alone",
    async (key) => {
      expect(await authorize("Bearer ", { ...tokens, [key]: "" })).toBeNull();
      expect(await authorize("Bearer  ", { ...tokens, [key]: " " })).toBeNull();
      expect(
        await authorize("Bearer \t", { ...tokens, [key]: "\t" }),
      ).toBeNull();
    },
  );

  it("trims the padding off a single secret", async () => {
    const padded = {
      ...tokens,
      MAIN_TOKEN: " main-secret ",
      PR_TOKEN: "\tpr-secret",
      E2E_TOKEN: "e2e-secret\n",
    };
    expect(await authorize("Bearer main-secret", padded)).toEqual({
      role: "main",
      repo: null,
    });
    expect(await authorize("Bearer pr-secret", padded)).toEqual({
      role: "pr",
      repo: null,
    });
    expect(await authorize("Bearer e2e-secret", padded)).toEqual({
      role: "e2e",
      repo: null,
    });
  });

  it.each([
    "READ_TOKENS",
    "HOST_TOKENS",
    "MAIN_TOKEN",
    "PR_TOKEN",
    "E2E_TOKEN",
    "REPO_MAIN_TOKENS",
  ] as const)(
    "still authorizes the other roles when %s is unset",
    async (key) => {
      const unset = Object.fromEntries(
        Object.entries(tokens).filter(([name]) => name !== key),
      );
      expect(await authorize("Bearer ", unset)).toBeNull();
      expect(await authorize("Bearer main-secret", unset)).toEqual(
        key === "MAIN_TOKEN" ? null : { role: "main", repo: null },
      );
      expect(await authorize("Bearer e2e-secret", unset)).toEqual(
        key === "E2E_TOKEN" ? null : { role: "e2e", repo: null },
      );
    },
  );

  it("refuses two tokens that differ only in padding", async () => {
    const padded = { ...tokens, MAIN_TOKEN: " shared ", PR_TOKEN: "shared" };
    expect(await authorize("Bearer shared", padded)).toBeNull();
  });

  it("matches a host token listed twice", async () => {
    const twice = { ...tokens, HOST_TOKENS: "host-a, host-a" };
    expect(await authorize("Bearer host-a", twice)).toEqual({
      role: "host",
      repo: null,
    });
  });

  it("matches a repository that holds several tokens", async () => {
    const several = { ...tokens, REPO_MAIN_TOKENS: "o/a=t1, o/a=t2" };
    expect(await authorize("Bearer t1", several)).toEqual({
      role: "main",
      repo: "o/a",
    });
    expect(await authorize("Bearer t2", several)).toEqual({
      role: "main",
      repo: "o/a",
    });
  });

  it("works without any repository tokens", async () => {
    const none = {
      READ_TOKENS: tokens.READ_TOKENS,
      HOST_TOKENS: tokens.HOST_TOKENS,
      MAIN_TOKEN: tokens.MAIN_TOKEN,
      PR_TOKEN: tokens.PR_TOKEN,
      E2E_TOKEN: tokens.E2E_TOKEN,
    };
    expect(await authorize("Bearer one-secret", none)).toBeNull();
    expect(await authorize("Bearer main-secret", none)).toEqual({
      role: "main",
      repo: null,
    });
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
    expect(await authorize("Bearer reader-a", unset)).toEqual({
      role: "read",
      repo: null,
    });
    expect(await authorize("Bearer host-a", unset)).toEqual({
      role: "host",
      repo: null,
    });
  });
});
