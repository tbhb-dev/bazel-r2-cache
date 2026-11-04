// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import { beforeEach, describe, expect, it } from "vitest";
import { type CacheEnv, handle, PR_HEADER } from "./cache.ts";
import worker, { type Env, VERSION_HEADER } from "./index.ts";
import { MemoryStore } from "./testing.ts";

// SHA-256 of "hello".
const HELLO =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const OTHER = "a".repeat(64);

let store: MemoryStore;
let env: CacheEnv;

beforeEach(() => {
  store = new MemoryStore();
  env = {
    CACHE: store,
    READ_TOKENS: "read-secret",
    HOST_TOKENS: "host-secret",
    MAIN_TOKEN: "main-secret",
    PR_TOKEN: "pr-secret",
    E2E_TOKEN: "e2e-secret",
  };
});

interface Options {
  readonly token?: string | null;
  readonly body?: string;
  readonly pr?: string;
}

function request(method: string, path: string, options: Options = {}) {
  const headers = new Headers();
  const token = options.token === undefined ? "main-secret" : options.token;
  if (token !== null) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (options.pr !== undefined) {
    headers.set(PR_HEADER, options.pr);
  }
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    init.body = options.body;
  }
  return new Request(`https://cache.test${path}`, init);
}

function put(key: string, text: string): void {
  store.objects.set(key, new TextEncoder().encode(text));
}

function stored(key: string): string | undefined {
  const value = store.objects.get(key);
  return value === undefined ? undefined : new TextDecoder().decode(value);
}

describe("routing", () => {
  it.each([
    "/",
    "/cas",
    `/blob/${HELLO}`,
    `/cas/${HELLO.slice(1)}`,
    `/cas/${HELLO}0`,
    `/cas/${HELLO.toUpperCase()}`,
    `/cas/${"g".repeat(64)}`,
    `/cas/${HELLO}/extra`,
    `/x/cas/${HELLO}`,
    `/ac/main/${HELLO}`,
  ])("doesn't serve %s", async (path) => {
    // An authorized write, so a path that slipped through would store
    // something or fail differently.
    const response = await handle(request("PUT", path, { body: "hello" }), env);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
    expect(store.objects.size).toBe(0);
  });

  it("asks for a bearer token", async () => {
    const response = await handle(
      request("GET", `/cas/${HELLO}`, { token: null }),
      env,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await response.text()).toBe("unauthorized");
  });

  it("allows only GET, HEAD and PUT", async () => {
    const response = await handle(request("DELETE", `/cas/${HELLO}`), env);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD, PUT");
    expect(await response.text()).toBe("method not allowed");
  });
});

describe("the pull request header", () => {
  it("is required with a pr token", async () => {
    const response = await handle(
      request("GET", `/ac/${HELLO}`, { token: "pr-secret" }),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      `${PR_HEADER} goes with a pr token, and only with one`,
    );
  });

  it.each(["read-secret", "main-secret", "host-secret", "e2e-secret"])(
    "is refused with %s",
    async (token) => {
      const response = await handle(
        request("GET", `/ac/${HELLO}`, { token, pr: "o/r/42" }),
        env,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe(
        `${PR_HEADER} goes with a pr token, and only with one`,
      );
    },
  );

  it.each([
    "42",
    "o/r",
    "o/r/0",
    "o/r/042",
    "o/r/-1",
    "o/r/4.2",
    "o/r/1234567890",
    "o/r/4 2",
    "o/r/42/x",
    "o//42",
    "/r/42",
    "-o/r/42",
    "o.x/r/42",
    `${"o".repeat(40)}/r/42`,
    `o/${"r".repeat(101)}/42`,
    "o/./42",
    "o/../42",
    "o/r#1/42",
    "",
  ])("must be owner/repo/number, not %j", async (pr) => {
    const response = await handle(
      request("PUT", `/ac/${HELLO}`, { token: "pr-secret", pr, body: "x" }),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      `${PR_HEADER} must be owner/repo/number`,
    );
    expect(store.objects.size).toBe(0);
  });

  it("accepts nine digits", async () => {
    const response = await handle(
      request("PUT", `/ac/${HELLO}`, {
        token: "pr-secret",
        pr: "o/r/123456789",
        body: "x",
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(stored(`ac/pr/o/r/123456789/${HELLO}`)).toBe("x");
  });

  it("files the entry under the repository in lowercase", async () => {
    const response = await handle(
      request("PUT", `/ac/${HELLO}`, {
        token: "pr-secret",
        pr: "TBHB-dev/.Bazel_R2-cache/7",
        body: "x",
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(stored(`ac/pr/tbhb-dev/.bazel_r2-cache/7/${HELLO}`)).toBe("x");
  });

  it("keeps the same number in two repositories apart", async () => {
    put(`ac/pr/o/a/3/${HELLO}`, "repository a");
    put(`ac/main/${HELLO}`, "main");
    const get = await handle(
      request("GET", `/ac/${HELLO}`, { token: "pr-secret", pr: "o/b/3" }),
      env,
    );
    expect(await get.text()).toBe("main");
  });
});

describe("reads", () => {
  it("serves a blob with its length", async () => {
    put(`cas/${HELLO}`, "hello");
    const response = await handle(
      request("GET", `/cas/${HELLO}`, { token: "read-secret" }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("5");
    expect(await response.text()).toBe("hello");
  });

  it("serves main's action cache to a read token", async () => {
    put(`ac/main/${HELLO}`, "entry");
    const response = await handle(
      request("GET", `/ac/${HELLO}`, { token: "read-secret" }),
      env,
    );
    expect(await response.text()).toBe("entry");
  });

  it("answers 404 for a missing entry", async () => {
    put(`ac/pr/o/r/1/${HELLO}`, "elsewhere");
    const response = await handle(
      request("GET", `/ac/${HELLO}`, { token: "read-secret" }),
      env,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });

  it("answers HEAD with the length and no body", async () => {
    put(`ac/main/${HELLO}`, "entry");
    const response = await handle(request("HEAD", `/ac/${HELLO}`), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("5");
    expect(await response.text()).toBe("");
  });

  it("answers HEAD for a missing entry with 404", async () => {
    const response = await handle(request("HEAD", `/cas/${HELLO}`), env);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("gives a pull request its own entry before main's", async () => {
    put(`ac/pr/o/r/7/${HELLO}`, "own");
    put(`ac/main/${HELLO}`, "main");
    const pr = { token: "pr-secret", pr: "o/r/7" };
    const get = await handle(request("GET", `/ac/${HELLO}`, pr), env);
    expect(await get.text()).toBe("own");
    const head = await handle(request("HEAD", `/ac/${HELLO}`, pr), env);
    expect(head.headers.get("Content-Length")).toBe("3");
  });

  it("falls back to main's entry for a pull request", async () => {
    put(`ac/pr/o/r/8/${HELLO}`, "another pull request");
    put(`ac/main/${HELLO}`, "main");
    const pr = { token: "pr-secret", pr: "o/r/7" };
    const get = await handle(request("GET", `/ac/${HELLO}`, pr), env);
    expect(await get.text()).toBe("main");
    const head = await handle(request("HEAD", `/ac/${HELLO}`, pr), env);
    expect(head.headers.get("Content-Length")).toBe("4");
  });

  it("gives a host main's entry before the hosts'", async () => {
    put(`ac/main/${HELLO}`, "main");
    put(`ac/host/${HELLO}`, "host");
    const host = { token: "host-secret" };
    const get = await handle(request("GET", `/ac/${HELLO}`, host), env);
    expect(await get.text()).toBe("main");
  });

  it("falls back to the hosts' entry for a host", async () => {
    put(`ac/host/${HELLO}`, "host");
    const host = { token: "host-secret" };
    const get = await handle(request("GET", `/ac/${HELLO}`, host), env);
    expect(await get.text()).toBe("host");
    const head = await handle(request("HEAD", `/ac/${HELLO}`, host), env);
    expect(head.headers.get("Content-Length")).toBe("4");
  });

  it.each([
    ["read-secret", undefined],
    ["main-secret", undefined],
    ["pr-secret", "o/r/7"],
  ])("keeps the hosts' entries from %s", async (token, pr) => {
    put(`ac/host/${HELLO}`, "host");
    const options = pr === undefined ? { token } : { token, pr };
    const get = await handle(request("GET", `/ac/${HELLO}`, options), env);
    expect(get.status).toBe(404);
  });

  it("keeps the end-to-end tests to their own namespace", async () => {
    put(`ac/main/${HELLO}`, "main");
    put(`cas/${HELLO}`, "hello");
    const e2e = { token: "e2e-secret" };
    const ac = await handle(request("GET", `/ac/${HELLO}`, e2e), env);
    expect(ac.status).toBe(404);
    const cas = await handle(request("HEAD", `/cas/${HELLO}`, e2e), env);
    expect(cas.status).toBe(404);
    put(`e2e/ac/${HELLO}`, "test");
    const own = await handle(request("GET", `/ac/${HELLO}`, e2e), env);
    expect(await own.text()).toBe("test");
  });
});

describe("writes", () => {
  it("stores a blob under its own digest", async () => {
    const response = await handle(
      request("PUT", `/cas/${HELLO}`, { body: "hello" }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(stored(`cas/${HELLO}`)).toBe("hello");
  });

  it("rejects a blob whose body doesn't match its digest", async () => {
    const response = await handle(
      request("PUT", `/cas/${OTHER}`, {
        token: "pr-secret",
        pr: "o/r/1",
        body: "hello",
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("body does not match its digest");
    expect(store.objects.size).toBe(0);
  });

  it.each([
    ["main-secret", undefined, `ac/main/${OTHER}`],
    ["pr-secret", "o/r/42", `ac/pr/o/r/42/${OTHER}`],
    ["host-secret", undefined, `ac/host/${OTHER}`],
    ["e2e-secret", undefined, `e2e/ac/${OTHER}`],
  ])(
    "stores %s's action cache entries in its namespace",
    async (token, pr, key) => {
      const options =
        pr === undefined
          ? { token, body: "result" }
          : { token, pr, body: "result" };
      const response = await handle(
        request("PUT", `/ac/${OTHER}`, options),
        env,
      );
      expect(response.status).toBe(200);
      expect([...store.objects.keys()]).toEqual([key]);
      expect(stored(key)).toBe("result");
    },
  );

  it("stores a host's blob in the shared pool", async () => {
    await handle(
      request("PUT", `/cas/${HELLO}`, { token: "host-secret", body: "hello" }),
      env,
    );
    expect([...store.objects.keys()]).toEqual([`cas/${HELLO}`]);
  });

  it("stores an end-to-end blob in its namespace", async () => {
    await handle(
      request("PUT", `/cas/${HELLO}`, { token: "e2e-secret", body: "hello" }),
      env,
    );
    expect([...store.objects.keys()]).toEqual([`e2e/cas/${HELLO}`]);
  });

  it.each(["cas", "ac"])(
    "refuses %s writes with a read token",
    async (kind) => {
      const response = await handle(
        request("PUT", `/${kind}/${HELLO}`, {
          token: "read-secret",
          body: "hello",
        }),
        env,
      );
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("forbidden");
      expect(store.objects.size).toBe(0);
    },
  );
});

describe("the Worker", () => {
  const VERSION = "0f6c1d2e-8a4b-4c3d-9e5f-1a2b3c4d5e6f";
  type WorkerRequest = Parameters<typeof worker.fetch>[0];

  function bindings(): Env {
    return {
      ...env,
      CF_VERSION_METADATA: { id: VERSION },
    } as unknown as Env;
  }

  it("serves requests through the cache and names its version", async () => {
    put(`cas/${HELLO}`, "hello");
    const response = await worker.fetch(
      request("GET", `/cas/${HELLO}`) as WorkerRequest,
      bindings(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get(VERSION_HEADER)).toBe(VERSION);
    expect(await response.text()).toBe("hello");
  });

  it("names its version on a refusal too, keeping the other headers", async () => {
    const response = await worker.fetch(
      request("GET", `/cas/${HELLO}`, { token: null }) as WorkerRequest,
      bindings(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get(VERSION_HEADER)).toBe(VERSION);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
  });
});
