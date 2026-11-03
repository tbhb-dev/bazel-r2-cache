// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

// The deploy's pre- and post-deploy check: exercises a deployed Worker as
// Bazel would, with the e2e token, whose writes land under e2e/ and expire
// after a day. worker_deploy sets WORKER_URL, WORKER_VERSION_ID (the new
// version) and WORKER_REQUEST_HEADERS (the version override before the
// traffic move); E2E_TOKEN comes through its pass_env. Every response must
// name WORKER_VERSION_ID in Bazel-Cache-Worker-Version, so a check that
// reached the old version fails. The token is never printed.
//
// A new deployment takes a moment to reach every Cloudflare server, so
// before the checks it waits until WORKER_VERSION_ID answers SETTLE_RUN
// requests in a row, giving up after E2E_SETTLE_SECONDS (default 60).

import { createHash, randomBytes } from "node:crypto";

const url = process.env.WORKER_URL;
const token = process.env.E2E_TOKEN;
if (!url || !token) {
  console.error("e2e: WORKER_URL and E2E_TOKEN must be set");
  process.exit(1);
}
const extra = JSON.parse(process.env.WORKER_REQUEST_HEADERS ?? "{}");
const version = process.env.WORKER_VERSION_ID;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const failures = [];

const SETTLE_RUN = 5;
const SETTLE_INTERVAL_MS = 500;
const settleSeconds = Number(process.env.E2E_SETTLE_SECONDS ?? "60");

// A response, or null after recording why the request failed: a timeout or
// network error is a failed check, not a crash.
async function call(name, method, path, { body, auth = true } = {}) {
  const headers = { ...extra };
  if (auth) {
    headers.Authorization = `Bearer ${token}`;
  }
  try {
    return await fetch(new URL(path, url), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    failures.push(`${name}: ${method} failed: ${error.message}`);
    return null;
  }
}

async function expect(name, [method, path, options], status, body) {
  const response = await call(name, method, path, options);
  if (response === null) {
    return;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const answered = response.headers.get("Bazel-Cache-Worker-Version");
  if (response.status !== status) {
    failures.push(`${name}: status ${response.status}, expected ${status}`);
  } else if (version && answered !== version) {
    failures.push(`${name}: version ${answered} answered, expected ${version}`);
  } else if (body !== undefined && !bytes.equals(body)) {
    failures.push(`${name}: the body differs from what was stored`);
  } else {
    console.log(`e2e: ok: ${name}`);
  }
}

// Waits until the new version answers SETTLE_RUN unauthenticated requests
// in a row (each refused with 401, so nothing is read or written), or
// records a failure at the deadline. A failed request breaks the run.
async function settle(path) {
  const deadline = Date.now() + settleSeconds * 1000;
  let run = 0;
  let last = "no version";
  while (run < SETTLE_RUN) {
    if (Date.now() >= deadline) {
      failures.push(
        `version ${version} didn't answer ${SETTLE_RUN} requests in a row within ${settleSeconds}s; ${last} answered last`,
      );
      return;
    }
    try {
      const response = await fetch(new URL(path, url), {
        headers: extra,
        signal: AbortSignal.timeout(15_000),
      });
      await response.arrayBuffer();
      last = response.headers.get("Bazel-Cache-Worker-Version") ?? "no version";
    } catch (error) {
      last = `no version (${error.message})`;
    }
    run = last === version ? run + 1 : 0;
    if (run < SETTLE_RUN) {
      await new Promise((r) => setTimeout(r, SETTLE_INTERVAL_MS));
    }
  }
  console.log(`e2e: ok: version ${version} answers`);
}

const blob = randomBytes(64);
const digest = sha256(blob);
const cas = `/cas/${digest}`;
const ac = `/ac/${digest}`;

if (version) {
  await settle(cas);
}
await expect(
  "a request without a token is refused",
  ["GET", cas, { auth: false }],
  401,
);
await expect("a missing blob is not found", ["GET", cas], 404);
await expect(
  "a blob that doesn't match its digest is refused",
  ["PUT", cas, { body: randomBytes(64) }],
  400,
);
await expect("a blob is stored", ["PUT", cas, { body: blob }], 200);
await expect("the blob reads back", ["GET", cas], 200, blob);
await expect("the blob is found by HEAD", ["HEAD", cas], 200);
await expect("an action result is stored", ["PUT", ac, { body: blob }], 200);
await expect("the action result reads back", ["GET", ac], 200, blob);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`e2e: FAIL: ${failure}`);
  }
  process.exit(1);
}
console.log(`e2e: ${url} passed`);
