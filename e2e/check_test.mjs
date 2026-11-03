// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

// Runs check.mjs against the Worker's own entry point, served over HTTP from
// an in-memory store, the way a deploy runs it against a deployed version.
// The server stands in for Cloudflare: it requires the version override
// header the deploy passes, and the Worker names its version.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";

const runfiles = process.env.RUNFILES_DIR ?? process.env.TEST_SRCDIR;
const root = join(runfiles, "_main");
const { default: worker } = await import(join(root, "src", "index.ts"));
const { MemoryStore } = await import(join(root, "src", "testing.ts"));

const E2E = "e2e-3c9f1a7b52";
const VERSION = "7d2e4f60-1b3c-4a5d-8e9f-0a1b2c3d4e5f";
const OVERRIDE = "Cloudflare-Workers-Version-Overrides";
const OLD = "00000000-0000-4000-8000-000000000000";

// answers(n) names the version that answers the nth request, from 0, as a
// server that hasn't seen the new deployment yet would; undefined keeps
// the Worker's own.
async function serve(env, answers = () => undefined) {
  let requests = 0;
  const server = createServer(async (req, res) => {
    const answer = answers(requests++);
    if (
      req.headers[OVERRIDE.toLowerCase()] !== `bazel-r2-cache-stg="${VERSION}"`
    ) {
      res.writeHead(412);
      res.end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const response = await worker.fetch(
      new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      }),
      env,
    );
    const headers = Object.fromEntries(response.headers);
    if (answer !== undefined) {
      headers["bazel-cache-worker-version"] = answer;
    }
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

function check(
  url,
  token,
  {
    headers = { [OVERRIDE]: `bazel-r2-cache-stg="${VERSION}"` },
    version = VERSION,
  } = {},
) {
  const child = spawn(process.execPath, [join(root, "e2e", "check.mjs")], {
    env: {
      ...process.env,
      WORKER_URL: url,
      E2E_TOKEN: token,
      WORKER_REQUEST_HEADERS: JSON.stringify(headers),
      WORKER_VERSION_ID: version,
      E2E_SETTLE_SECONDS: "8",
    },
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  return new Promise((r) =>
    child.on("close", (status) => r({ status, output })),
  );
}

const env = {
  CACHE: new MemoryStore(),
  READ_TOKENS: "",
  MAIN_TOKEN: "",
  PR_TOKEN: "",
  E2E_TOKEN: E2E,
  CF_VERSION_METADATA: { id: VERSION },
};

test("passes against a working Worker and never prints the token", async () => {
  const server = await serve(env);
  const { port } = server.address();
  const r = await check(`http://127.0.0.1:${port}`, E2E);
  server.close();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /passed/);
  assert.ok(!r.output.includes(E2E));
});

test("waits until the new version answers in a row", async () => {
  // The old version answers at first, then the new one once, then the old
  // again: only an unbroken run of the new one ends the wait.
  const stale = [OLD, OLD, undefined, OLD];
  const server = await serve(env, (n) => (n < stale.length ? stale[n] : undefined));
  const { port } = server.address();
  const r = await check(`http://127.0.0.1:${port}`, E2E);
  server.close();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, new RegExp(`ok: version ${VERSION} answers`));
  assert.doesNotMatch(r.output, /FAIL/);
});

test("fails when the Worker refuses the token", async () => {
  const server = await serve(env);
  const { port } = server.address();
  const r = await check(`http://127.0.0.1:${port}`, "wrong-token");
  server.close();
  assert.equal(r.status, 1);
  assert.match(r.output, /FAIL: a missing blob is not found: status 401/);
  assert.ok(!r.output.includes("wrong-token"));
});

test("fails when the request headers aren't sent", async () => {
  const server = await serve(env);
  const { port } = server.address();
  const r = await check(`http://127.0.0.1:${port}`, E2E, { headers: {} });
  server.close();
  assert.equal(r.status, 1);
  assert.match(r.output, /status 412/);
});

test("fails when another version answers", async () => {
  const server = await serve(env);
  const { port } = server.address();
  const r = await check(`http://127.0.0.1:${port}`, E2E, { version: OLD });
  server.close();
  assert.equal(r.status, 1);
  assert.match(
    r.output,
    new RegExp(
      `FAIL: version ${OLD} didn't answer 5 requests in a row within 8s; ${VERSION} answered last`,
    ),
  );
  assert.match(
    r.output,
    new RegExp(`version ${VERSION} answered, expected ${OLD}`),
  );
});

test("records an unreachable Worker as a failure", async () => {
  const server = await serve(env);
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  const r = await check(`http://127.0.0.1:${port}`, E2E);
  assert.equal(r.status, 1);
  assert.match(r.output, /FAIL: .*GET failed/);
  assert.doesNotMatch(r.output, /at async/);
});
