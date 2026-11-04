// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

// Runs check.mjs against the Worker's own entry point, served over HTTP from
// an in-memory store, the way a deploy runs it against a deployed version.
// The server stands in for Cloudflare: it requires the version override
// header the deploy passes, and the Worker names its version.

import { createServer } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import worker from "../src/index.ts";
import { MemoryStore } from "../src/testing.ts";
import { run } from "./check.mjs";

const E2E = "e2e-3c9f1a7b52";
const VERSION = "7d2e4f60-1b3c-4a5d-8e9f-0a1b2c3d4e5f";
const OVERRIDE = "Cloudflare-Workers-Version-Overrides";
const PIN = `bazel-r2-cache-stg="${VERSION}"`;

const env = {
  CACHE: new MemoryStore(),
  READ_TOKENS: "",
  MAIN_TOKEN: "",
  PR_TOKEN: "",
  E2E_TOKEN: E2E,
  CF_VERSION_METADATA: { id: VERSION },
};

const servers = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r))),
  );
  vi.unstubAllEnvs();
});

// The Worker behind a stand-in for Cloudflare's edge, at the returned URL.
// With `corrupt`, a GET answers a byte off from what the Worker sent.
async function serve({ corrupt = false } = {}) {
  const server = createServer(async (req, res) => {
    if (req.headers[OVERRIDE.toLowerCase()] !== PIN) {
      res.writeHead(412);
      res.end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const response = await worker.fetch(
      new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
      }),
      env,
    );
    const body = Buffer.from(await response.arrayBuffer());
    if (corrupt && body.length > 0) {
      body[0] ^= 1;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(body);
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}

// The deploy's environment for a check against url.
function deploy(url, overrides = {}) {
  return {
    WORKER_URL: url,
    E2E_TOKEN: E2E,
    WORKER_REQUEST_HEADERS: JSON.stringify({ [OVERRIDE]: PIN }),
    WORKER_VERSION_ID: VERSION,
    ...overrides,
  };
}

// Runs the check, returning its status and everything it wrote.
async function check(environment) {
  let output = "";
  const write = (line) => {
    output += `${line}\n`;
  };
  const status = await run(environment, { log: write, error: write });
  return { status, output };
}

describe("run", () => {
  test("passes against a working Worker and never prints the token", async () => {
    const r = await check(deploy(await serve()));
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/passed/);
    expect(r.output).not.toContain(E2E);
  });

  test("passes without a version to require", async () => {
    const r = await check(
      deploy(await serve(), { WORKER_VERSION_ID: undefined }),
    );
    expect(r.status, r.output).toBe(0);
  });

  test.each([
    ["WORKER_URL", { WORKER_URL: "" }],
    ["E2E_TOKEN", { E2E_TOKEN: undefined }],
  ])("refuses to run without %s", async (_, overrides) => {
    const r = await check(deploy("http://127.0.0.1:9", overrides));
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/WORKER_URL and E2E_TOKEN must be set/);
  });

  test("fails when the Worker refuses the token", async () => {
    const r = await check(
      deploy(await serve(), { E2E_TOKEN: "wrong-token" }),
    );
    expect(r.status).toBe(1);
    expect(r.output).toMatch(
      /FAIL: a missing blob is not found: status 401/,
    );
    expect(r.output).not.toContain("wrong-token");
  });

  test("fails when the request headers aren't sent", async () => {
    const r = await check(
      deploy(await serve(), { WORKER_REQUEST_HEADERS: undefined }),
    );
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/status 412/);
  });

  test("fails when another version answers", async () => {
    const other = "00000000-0000-4000-8000-000000000000";
    const r = await check(deploy(await serve(), { WORKER_VERSION_ID: other }));
    expect(r.status).toBe(1);
    expect(r.output).toContain(`version ${VERSION} answered, expected ${other}`);
  });

  test("fails when a stored body reads back different", async () => {
    const r = await check(deploy(await serve({ corrupt: true })));
    expect(r.status).toBe(1);
    expect(r.output).toMatch(
      /FAIL: the blob reads back: the body differs from what was stored/,
    );
  });

  test("records an unreachable Worker as a failure", async () => {
    const url = await serve();
    await new Promise((r) => servers.pop().close(r));
    const r = await check(deploy(url));
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/FAIL: .*GET failed/);
    expect(r.output).not.toMatch(/at async/);
  });
});

test("main.mjs runs the check from the process environment", async () => {
  for (const [name, value] of Object.entries(deploy(await serve()))) {
    vi.stubEnv(name, value);
  }
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await import("./main.mjs");
    expect(process.exitCode).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/passed$/));
  } finally {
    process.exitCode = undefined;
    log.mockRestore();
  }
});
