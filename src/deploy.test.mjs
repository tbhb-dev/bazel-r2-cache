// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readRepoFile(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function tokenSecretsKeys(buildBazel) {
  const lines = buildBazel.split("\n");
  const start = lines.findIndex((line) => line.trim() === "TOKEN_SECRETS = {");
  expect(start).toBeGreaterThan(-1);
  const end = lines.indexOf("}", start + 1);
  expect(end).toBeGreaterThan(start);
  const keys = [];
  for (const line of lines.slice(start + 1, end)) {
    const match = /^\s*"([A-Z0-9_]+)":\s*"([A-Z0-9_]+)",?$/.exec(line);
    if (match !== null) {
      expect(match[1]).toBe(match[2]);
      keys.push(match[1]);
    }
  }
  return keys;
}

function deployEnvKeys(workflow) {
  const lines = workflow.split("\n");
  const step = lines.findIndex(
    (line) => line.trim() === "- name: Deploy and test",
  );
  expect(step).toBeGreaterThan(-1);
  const envLine = lines.findIndex(
    (line, index) => index > step && line.trim() === "env:",
  );
  expect(envLine).toBeGreaterThan(step);
  const envIndent = lines[envLine].search(/\S/);
  const keys = [];
  for (const line of lines.slice(envLine + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    if (line.search(/\S/) <= envIndent) {
      break;
    }
    const match = /^\s*([A-Z0-9_]+):/.exec(line);
    if (match !== null) {
      keys.push(match[1]);
    }
  }
  return keys;
}

function workerEnvTokenSecrets(indexTs) {
  const lines = indexTs.split("\n");
  const start = lines.findIndex(
    (line) => line.trim() === "export interface Env {",
  );
  expect(start).toBeGreaterThan(-1);
  const end = lines.indexOf("}", start + 1);
  expect(end).toBeGreaterThan(start);
  const keys = [];
  for (const line of lines.slice(start + 1, end)) {
    const match = /^\s*readonly\s+([A-Z0-9_]+)\?:\s*string;$/.exec(line);
    if (match !== null) {
      keys.push(match[1]);
    }
  }
  return keys;
}

describe("deploy token secrets", () => {
  it("keeps Worker Env, TOKEN_SECRETS and deploy.yml in sync", () => {
    const tokenSecrets = tokenSecretsKeys(readRepoFile("../BUILD.bazel"));
    const deployEnv = new Set(
      deployEnvKeys(readRepoFile("../.github/workflows/deploy.yml")),
    );
    const workerSecrets = workerEnvTokenSecrets(readRepoFile("./index.ts"));

    expect(tokenSecrets.length).toBeGreaterThan(0);
    expect(workerSecrets.length).toBeGreaterThan(0);

    for (const secret of workerSecrets) {
      expect(
        tokenSecrets,
        `${secret} from Env is missing from TOKEN_SECRETS`,
      ).toContain(secret);
    }
    for (const secret of tokenSecrets) {
      expect(
        deployEnv.has(secret),
        `${secret} from TOKEN_SECRETS is missing from Deploy and test env`,
      ).toBe(true);
    }
  });
});
