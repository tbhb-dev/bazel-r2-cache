// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import { afterEach, describe, expect, it, vi } from "vitest";
import { authorize } from "./auth.ts";
import {
  type Claims,
  fromBase64,
  type SignedSettings,
  signCiToken,
  toBase64Url,
} from "./token.ts";

const ORIGIN = "https://bazel-cache.tbhb.dev";
const STAGING = "https://bazel-cache-stg.tbhb.dev";
const IAT = 2_000_000_000;
const NOW = (IAT + 60) * 1000;
const SECRET = `ci-${crypto.randomUUID()}`;
const settings: SignedSettings = { CI_TOKEN_SIGNING_SECRET: SECRET };

function claims(over: Record<string, unknown>): Claims {
  return {
    role: "main",
    repo: "o/r",
    aud: ORIGIN,
    jti: "id-1",
    iat: IAT,
    exp: IAT + 600,
    ...over,
  };
}
const ci = (over: Record<string, unknown> = {}, secret = SECRET) =>
  signCiToken(claims(over), secret);
const check = (token: string, over: SignedSettings = {}, origin = ORIGIN) =>
  authorize(`Bearer ${token}`, { ...settings, ...over }, origin, NOW);
const parts = (token: string) => token.split(".") as [string, string, string];

// A token of any kind and payload text, signed with the real secret.
async function forge(kind: string, payload: string): Promise<string> {
  const head = `${kind}.${toBase64Url(new TextEncoder().encode(payload))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sign = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(head),
  );
  return `${head}.${toBase64Url(new Uint8Array(sign))}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("base64url", () => {
  it("swaps the url-unsafe characters and drops the padding", () => {
    const bytes = Uint8Array.of(0xfb, 0xff, 0xbe, 0xfb);
    expect(toBase64Url(bytes)).toBe("-_---w");
    expect(fromBase64("-_---w")).toEqual(bytes);
    expect(fromBase64("+/+++w==")).toEqual(bytes);
    expect(() => fromBase64("a")).toThrow();
  });
});

describe("ci1 tokens", () => {
  it.each([
    ["main", { role: "main" }, { role: "main", repo: "o/r", pr: null }],
    ["pr", { role: "pr", pr: 7 }, { role: "pr", repo: "o/r", pr: 7 }],
    ["read", { role: "read" }, { role: "read", repo: null, pr: null }],
  ])("accepts a %s token", async (_, over, identity) => {
    expect(await check(await ci(over))).toEqual(identity);
  });

  it.each(["org/my.repo-1", "o-1/.github"])(
    "accepts the repository %s",
    async (repo) => {
      expect(await check(await ci({ repo }))).toMatchObject({ repo });
    },
  );

  it("accepts a token until its expiry second", async () => {
    expect(await check(await ci({ exp: IAT + 61 }))).not.toBeNull();
    expect(await check(await ci({ exp: IAT + 60 }))).toBeNull();
    expect(await check(await ci({ exp: IAT - 1 }))).toBeNull();
  });

  it("refuses a token for the staging origin at the production origin", async () => {
    expect(await check(await ci({ aud: STAGING }))).toBeNull();
    expect(await check(await ci({ aud: STAGING }), {}, STAGING)).not.toBeNull();
  });

  it("refuses a bad signature, a tampered payload and the wrong key", async () => {
    const good = await ci();
    const [kind, , signature] = parts(good);
    const [, pr] = parts(await ci({ role: "pr", pr: 7 }));
    expect(await check(`${kind}.${pr}.${signature}`)).toBeNull();
    expect(await check(`${good.slice(0, -2)}AA`)).toBeNull();
    expect(await check(await ci({}, `${SECRET}x`))).toBeNull();
  });

  it.each(["ci1", "ci1.", "ci1.a", "ci1.a.b", "ci1..", "ci1.!.!"])(
    "refuses the malformed text %s",
    async (token) => {
      expect(await check(token)).toBeNull();
    },
  );

  it("refuses a token with a fourth part", async () => {
    expect(await check(`${await ci()}.x`)).toBeNull();
  });

  it("refuses a host1 token even when its text is signed with the secret", async () => {
    const payload = JSON.stringify(claims({}));
    expect(await check(await forge("ci1", payload))).not.toBeNull();
    expect(await check(await forge("host1", payload))).toBeNull();
    expect(await check(await forge("ci1", "not json"))).toBeNull();
  });

  it.each([
    ["a host role", { role: "host" }],
    ["an unknown role", { role: "e2e" }],
    ["no repository in a main token", { repo: undefined }],
    ["no repository in a pr token", { role: "pr", pr: 7, repo: undefined }],
    ["no number in a pr token", { role: "pr" }],
    ["a pr number of zero", { role: "pr", pr: 0 }],
    ["a text pr number", { role: "pr", pr: "7" }],
    ["no token id", { jti: undefined }],
    ["a text expiry", { exp: "9999999999" }],
    ["a repository in an array", { repo: ["o/r"] }],
  ])("refuses a token with %s", async (_, over) => {
    expect(await check(await ci(over))).toBeNull();
  });

  it.each(["O/r", "o/R", "o/", "/r", "o/.", "o/..", "o/r/x", "!o/r"])(
    "refuses the repository %s",
    async (repo) => {
      expect(await check(await ci({ repo }))).toBeNull();
    },
  );

  it.each([undefined, ""])(
    "never accepts a token while the secret is %j",
    async (secret) => {
      const over = { CI_TOKEN_SIGNING_SECRET: secret } as SignedSettings;
      expect(await check(await ci(), over)).toBeNull();
    },
  );

  it("never matches a malformed signed token to a list entry", async () => {
    const lists = { READ_TOKENS: "ci1.bad, host1.bad", HOST_TOKENS: "ci1.x" };
    for (const token of ["ci1.bad", "host1.bad", "ci1.x"]) {
      expect(await authorize(`Bearer ${token}`, lists, ORIGIN, NOW)).toBeNull();
    }
  });
});

describe("list tokens", () => {
  it("log one line with the role and not the token", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const lists = { READ_TOKENS: "reader-secret" };
    const identity = await authorize(
      "Bearer reader-secret",
      lists,
      ORIGIN,
      NOW,
    );
    expect(identity).toEqual({ role: "read", repo: null, pr: null });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('{"event":"list-token","role":"read"}');
    expect(await authorize("Bearer nope", lists, ORIGIN, NOW)).toBeNull();
    expect(log).toHaveBeenCalledOnce();
  });
});
