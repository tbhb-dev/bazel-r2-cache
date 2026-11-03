// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

// The deploy's pre- and post-deploy check: exercises a deployed Worker as
// Bazel would, with the e2e token, whose writes land under e2e/ and expire
// after a day. worker_deploy sets WORKER_URL and WORKER_REQUEST_HEADERS
// (the version override before the traffic move); E2E_TOKEN comes through
// its pass_env. The token is never printed.

import { createHash, randomBytes } from "node:crypto";

const url = process.env.WORKER_URL;
const token = process.env.E2E_TOKEN;
if (!url || !token) {
  console.error("e2e: WORKER_URL and E2E_TOKEN must be set");
  process.exit(1);
}
const extra = JSON.parse(process.env.WORKER_REQUEST_HEADERS ?? "{}");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function call(method, path, { body, auth = true } = {}) {
  const headers = { ...extra };
  if (auth) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(new URL(path, url), {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  });
}

const failures = [];
async function expect(name, response, status, body) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status !== status) {
    failures.push(`${name}: status ${response.status}, expected ${status}`);
  } else if (body !== undefined && !bytes.equals(body)) {
    failures.push(`${name}: the body differs from what was stored`);
  } else {
    console.log(`e2e: ok: ${name}`);
  }
}

const blob = randomBytes(64);
const digest = sha256(blob);

await expect(
  "a request without a token is refused",
  await call("GET", `/cas/${digest}`, { auth: false }),
  401,
);
await expect(
  "a missing blob is not found",
  await call("GET", `/cas/${digest}`),
  404,
);
await expect(
  "a blob that doesn't match its digest is refused",
  await call("PUT", `/cas/${digest}`, { body: randomBytes(64) }),
  400,
);
await expect(
  "a blob is stored",
  await call("PUT", `/cas/${digest}`, { body: blob }),
  200,
);
await expect(
  "the blob reads back",
  await call("GET", `/cas/${digest}`),
  200,
  blob,
);
await expect(
  "the blob is found by HEAD",
  await call("HEAD", `/cas/${digest}`),
  200,
);
await expect(
  "an action result is stored",
  await call("PUT", `/ac/${digest}`, { body: blob }),
  200,
);
await expect(
  "the action result reads back",
  await call("GET", `/ac/${digest}`),
  200,
  blob,
);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`e2e: FAIL: ${failure}`);
  }
  process.exit(1);
}
console.log(`e2e: ${url} passed`);
