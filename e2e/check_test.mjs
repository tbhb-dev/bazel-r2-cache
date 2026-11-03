// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

// Runs check.mjs against the Worker's own handler, served over HTTP from an
// in-memory store, the way a deploy runs it against a deployed version.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";

const runfiles = process.env.RUNFILES_DIR ?? process.env.TEST_SRCDIR;
const root = join(runfiles, "_main");
const { handle } = await import(join(root, "src", "cache.ts"));
const { MemoryStore } = await import(join(root, "src", "testing.ts"));

const E2E = "e2e-3c9f1a7b52";

async function serve(env) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const response = await handle(
      new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      }),
      env,
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

function check(url, token, headers = {}) {
  const child = spawn(process.execPath, [join(root, "e2e", "check.mjs")], {
    env: {
      ...process.env,
      WORKER_URL: url,
      E2E_TOKEN: token,
      WORKER_REQUEST_HEADERS: JSON.stringify(headers),
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
};

test("passes against a working Worker and never prints the token", async () => {
  const server = await serve(env);
  const { port } = server.address();
  const r = await check(`http://127.0.0.1:${port}`, E2E, { "X-Ignored": "1" });
  server.close();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /passed/);
  assert.ok(!r.output.includes(E2E));
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
