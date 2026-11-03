// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import { beforeEach, describe, expect, it } from "vitest";
import { type CacheEnv, handle } from "./cache.ts";
import worker, { type Env } from "./index.ts";
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
    READ_TOKEN: "read-secret",
    WRITE_TOKEN: "write-secret",
  };
});

function request(
  method: string,
  path: string,
  token: string | null,
  body?: string,
): Request {
  const headers = new Headers();
  if (token !== null) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return new Request(
    `https://cache.test${path}`,
    body === undefined ? { method, headers } : { method, headers, body },
  );
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
  ])("doesn't serve %s", async (path) => {
    // An authorized write, so a path that slipped through would store
    // something or fail differently.
    const response = await handle(
      request("PUT", path, "write-secret", "hello"),
      env,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
    expect(store.objects.size).toBe(0);
  });

  it("asks for a bearer token", async () => {
    const response = await handle(request("GET", `/cas/${HELLO}`, null), env);
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await response.text()).toBe("unauthorized");
  });

  it("allows only GET, HEAD and PUT", async () => {
    const response = await handle(
      request("DELETE", `/cas/${HELLO}`, "write-secret"),
      env,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD, PUT");
    expect(await response.text()).toBe("method not allowed");
  });
});

describe("reads", () => {
  it("serves a stored entry with its length", async () => {
    store.objects.set(`cas/${HELLO}`, new TextEncoder().encode("hello"));
    const response = await handle(
      request("GET", `/cas/${HELLO}`, "read-secret"),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("5");
    expect(await response.text()).toBe("hello");
  });

  it("answers 404 for a missing entry", async () => {
    const response = await handle(
      request("GET", `/ac/${HELLO}`, "read-secret"),
      env,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });

  it("answers HEAD with the length and no body", async () => {
    store.objects.set(`ac/${HELLO}`, new TextEncoder().encode("entry"));
    const response = await handle(
      request("HEAD", `/ac/${HELLO}`, "read-secret"),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("5");
    expect(await response.text()).toBe("");
  });

  it("answers HEAD for a missing entry with 404", async () => {
    const response = await handle(
      request("HEAD", `/cas/${HELLO}`, "read-secret"),
      env,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});

describe("writes", () => {
  it("stores a blob under its own digest", async () => {
    const response = await handle(
      request("PUT", `/cas/${HELLO}`, "write-secret", "hello"),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(new TextDecoder().decode(store.objects.get(`cas/${HELLO}`))).toBe(
      "hello",
    );
  });

  it("rejects a blob whose body doesn't match its digest", async () => {
    const response = await handle(
      request("PUT", `/cas/${OTHER}`, "write-secret", "hello"),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("body does not match its digest");
    expect(store.objects.size).toBe(0);
  });

  it("stores an action cache entry without a digest check", async () => {
    const response = await handle(
      request("PUT", `/ac/${OTHER}`, "write-secret", "result"),
      env,
    );
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(store.objects.get(`ac/${OTHER}`))).toBe(
      "result",
    );
  });

  it("refuses writes with a read token", async () => {
    const response = await handle(
      request("PUT", `/cas/${HELLO}`, "read-secret", "hello"),
      env,
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
    expect(store.objects.size).toBe(0);
  });
});

describe("the Worker", () => {
  it("serves requests through the cache", async () => {
    const bindings = env as unknown as Env;
    type WorkerRequest = Parameters<typeof worker.fetch>[0];
    store.objects.set(`cas/${HELLO}`, new TextEncoder().encode("hello"));
    const response = await worker.fetch(
      request("GET", `/cas/${HELLO}`, "read-secret") as WorkerRequest,
      bindings,
    );
    expect(await response.text()).toBe("hello");
  });
});
