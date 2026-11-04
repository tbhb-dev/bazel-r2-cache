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
// main.mjs runs it; check.test.mjs runs it against the Worker's own entry
// point.

import { createHash, randomBytes } from "node:crypto";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Runs the check against env's Worker and returns the exit status, writing
// progress to out.log and failures to out.error.
export async function run(env, out = console) {
  const url = env.WORKER_URL;
  const token = env.E2E_TOKEN;
  if (!url || !token) {
    out.error("e2e: WORKER_URL and E2E_TOKEN must be set");
    return 1;
  }
  const extra = JSON.parse(env.WORKER_REQUEST_HEADERS ?? "{}");
  const version = env.WORKER_VERSION_ID;
  const failures = [];

  // A response, or null after recording why the request failed: a timeout
  // or network error is a failed check, not a crash.
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
      failures.push(
        `${name}: version ${answered} answered, expected ${version}`,
      );
    } else if (body !== undefined && !bytes.equals(body)) {
      failures.push(`${name}: the body differs from what was stored`);
    } else {
      out.log(`e2e: ok: ${name}`);
    }
  }

  const blob = randomBytes(64);
  const digest = sha256(blob);
  const cas = `/cas/${digest}`;
  const ac = `/ac/${digest}`;

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
      out.error(`e2e: FAIL: ${failure}`);
    }
    return 1;
  }
  out.log(`e2e: ${url} passed`);
  return 0;
}
