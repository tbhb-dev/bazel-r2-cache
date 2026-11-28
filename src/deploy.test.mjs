// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readRepoFile(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function buildDictKeys(buildBazel, name) {
  const match = new RegExp(`^${name} = \\{([^}]*)\\}`, "m").exec(buildBazel);
  expect(match, `${name} dict is missing from BUILD.bazel`).not.toBeNull();
  const keys = [];
  for (const entry of match[1].matchAll(/"([A-Z0-9_]+)":\s*"([A-Z0-9_]+)"/g)) {
    expect(entry[1]).toBe(entry[2]);
    keys.push(entry[1]);
  }
  return keys;
}

function workerDeployBlocks(buildBazel) {
  const lines = buildBazel.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "worker_deploy(") {
      continue;
    }
    const end = lines.indexOf(")", index + 1);
    expect(end).toBeGreaterThan(index);
    blocks.push(lines.slice(index, end + 1).join("\n"));
  }
  return blocks;
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

function deployRunLines(workflow) {
  const lines = workflow.split("\n");
  const step = lines.findIndex(
    (line) => line.trim() === "- name: Deploy and test",
  );
  expect(step).toBeGreaterThan(-1);
  const runLine = lines.findIndex(
    (line, index) => index > step && line.trim() === "run: |",
  );
  expect(runLine).toBeGreaterThan(step);
  const runIndent = lines[runLine].search(/\S/);
  const body = [];
  for (const line of lines.slice(runLine + 1)) {
    if (line.trim() === "") {
      body.push(line);
      continue;
    }
    if (line.search(/\S/) <= runIndent) {
      break;
    }
    body.push(line);
  }
  return body;
}

// Reads the `readonly NAME?: string;` lines declared in Env itself. Env may
// extend other interfaces (SignedSettings holds the signed-token settings);
// their keys are not read here, because the deploy does not pass them yet.
function workerEnvTokenSecrets(indexTs) {
  const lines = indexTs.split("\n");
  const start = lines.findIndex((line) =>
    /^export interface Env\b[^{]*\{$/.test(line.trim()),
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

describe("workerEnvTokenSecrets", () => {
  it("reads the optional string keys of a plain Env", () => {
    const source = [
      "export interface Env {",
      "  readonly CACHE: R2Bucket;",
      "  readonly READ_TOKENS?: string;",
      "  readonly PR_TOKEN?: string;",
      "}",
    ].join("\n");
    expect(workerEnvTokenSecrets(source)).toEqual(["READ_TOKENS", "PR_TOKEN"]);
  });

  it("reads an Env that extends other interfaces, but not their keys", () => {
    const source = [
      "export interface SignedSettings {",
      "  readonly CI_TOKEN_SIGNING_SECRET?: string;",
      "}",
      "export interface Env extends SignedSettings, Other {",
      "  readonly READ_TOKENS?: string;",
      "  readonly CF_VERSION_METADATA: { readonly id: string };",
      "}",
    ].join("\n");
    expect(workerEnvTokenSecrets(source)).toEqual(["READ_TOKENS"]);
  });

  it("fails when there is no Env interface", () => {
    const source = [
      "export interface Environment {",
      "  readonly READ_TOKENS?: string;",
      "}",
    ].join("\n");
    expect(() => workerEnvTokenSecrets(source)).toThrow();
  });
});

describe("deploy token secrets", () => {
  it("keeps Worker Env, TOKEN_SECRETS, OPTIONAL_TOKEN_SECRETS and deploy.yml in sync", () => {
    const buildBazel = readRepoFile("../BUILD.bazel");
    const requiredSecrets = buildDictKeys(buildBazel, "TOKEN_SECRETS");
    const optionalSecrets = buildDictKeys(buildBazel, "OPTIONAL_TOKEN_SECRETS");
    const allSecrets = [...requiredSecrets, ...optionalSecrets];
    const deployEnv = new Set(
      deployEnvKeys(readRepoFile("../.github/workflows/deploy.yml")),
    );
    const workerSecrets = workerEnvTokenSecrets(readRepoFile("./index.ts"));

    expect(requiredSecrets.length).toBeGreaterThan(0);
    expect(optionalSecrets.length).toBeGreaterThan(0);
    expect(workerSecrets.length).toBeGreaterThan(0);

    for (const secret of workerSecrets) {
      expect(
        allSecrets,
        `${secret} from Env is missing from TOKEN_SECRETS and OPTIONAL_TOKEN_SECRETS`,
      ).toContain(secret);
    }
    for (const secret of allSecrets) {
      expect(
        deployEnv.has(secret),
        `${secret} is missing from Deploy and test env`,
      ).toBe(true);
    }
  });

  it("keeps REPO_MAIN_TOKENS optional and warns with DEPLOY_ENV when empty", () => {
    const buildBazel = readRepoFile("../BUILD.bazel");
    const workflow = readRepoFile("../.github/workflows/deploy.yml");
    const requiredSecrets = buildDictKeys(buildBazel, "TOKEN_SECRETS");
    const optionalSecrets = buildDictKeys(buildBazel, "OPTIONAL_TOKEN_SECRETS");

    expect(optionalSecrets).toContain("REPO_MAIN_TOKENS");
    expect(requiredSecrets).not.toContain("REPO_MAIN_TOKENS");

    const deployBlocks = workerDeployBlocks(buildBazel);
    expect(deployBlocks).toHaveLength(2);
    for (const target of ["deploy_stg", "deploy_prd"]) {
      const block = deployBlocks.find((entry) =>
        entry.includes(`name = "${target}",`),
      );
      expect(block, `worker_deploy target ${target} is missing`).toBeDefined();
      expect(
        block,
        `${target} must pass optional_secrets = OPTIONAL_TOKEN_SECRETS`,
      ).toMatch(/^\s*optional_secrets = OPTIONAL_TOKEN_SECRETS,$/m);
    }

    const runBody = deployRunLines(workflow)
      .join("\n")
      .replace(/"\s*\\\n\s*"/g, " ");
    expect(runBody).toContain(
      `::warning::REPO_MAIN_TOKENS is empty in the \${DEPLOY_ENV} Environment; keeping the Worker's existing secret`,
    );
  });
});
