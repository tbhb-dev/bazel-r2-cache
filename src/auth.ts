// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import { sha256Hex } from "./digest.ts";

/**
 * What a token may do:
 * - read: read main's action cache and the blobs; developers
 * - main: read and write main's action cache and the blobs; pushes to main.
 *   A token from `REPO_MAIN_TOKENS` is bound to one repository and reads and
 *   writes only that repository's part of main's action cache
 * - pr: read a pull request's action cache, then main's, and write the
 *   pull request's and the blobs; pull requests from organization branches
 * - host: read main's action cache, then the hosts', and write the hosts'
 *   and the blobs; the trusted build hosts, which share their own results
 * - e2e: read and write only the end-to-end tests' own namespace
 */
export type Role = "read" | "main" | "pr" | "host" | "e2e";

/** The Worker secrets that hold the bearer tokens. */
export interface Tokens {
  /** Comma-separated: one read token per consumer, so each can be revoked. */
  readonly READ_TOKENS: string;
  /** Comma-separated: one host token per build host, likewise. */
  readonly HOST_TOKENS: string;
  readonly MAIN_TOKEN: string;
  readonly PR_TOKEN: string;
  readonly E2E_TOKEN: string;
  /**
   * Comma-separated `owner/repo=token` entries: one main token per
   * repository, so each can be revoked and none writes another's cache.
   */
  readonly REPO_MAIN_TOKENS?: string;
}

/** Who a token belongs to: its role and, for a repository's main token, the repository. */
export interface Identity {
  readonly role: Role;
  /** `owner/repo` in lowercase, or null for every token not bound to one. */
  readonly repo: string | null;
}

const BEARER = "Bearer ";

/**
 * The identity of the bearer token in an `Authorization` header, or null
 * when the header is missing, malformed, or holds no known token. An unset
 * (empty) secret or list entry never matches.
 */
export async function authorize(
  header: string | null,
  tokens: Tokens,
): Promise<Identity | null> {
  if (header?.startsWith(BEARER) !== true) {
    return null;
  }
  const given = await digestOf(header.slice(BEARER.length));
  const candidates: [Identity, string][] = [
    [{ role: "main", repo: null }, tokens.MAIN_TOKEN],
    [{ role: "pr", repo: null }, tokens.PR_TOKEN],
    [{ role: "e2e", repo: null }, tokens.E2E_TOKEN],
    ...list("read", tokens.READ_TOKENS),
    ...list("host", tokens.HOST_TOKENS),
    // Stryker disable next-line StringLiteral: text without an entry parses to no entries, so the fallback's text never matters
    ...repoMain(tokens.REPO_MAIN_TOKENS ?? ""),
  ];
  for (const [identity, secret] of candidates) {
    if (secret !== "" && (await digestOf(secret)) === given) {
      return identity;
    }
  }
  return null;
}

function list(role: Role, secret: string): [Identity, string][] {
  return secret.split(",").map((t) => [{ role, repo: null }, t.trim()]);
}

// One `owner/repo=token` entry. GitHub compares names without case, so the
// repository is matched in any case and kept in lowercase. A repository
// named `.` or `..` never matches.
const ENTRY =
  /^\s*(?<repo>[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}\s*=)[A-Za-z0-9._-]{1,100})\s*=\s*(?<token>\S+)\s*$/;

// An entry that doesn't fit `ENTRY` never matches.
function repoMain(secret: string): [Identity, string][] {
  const entries: [Identity, string][] = [];
  for (const entry of secret.split(",")) {
    const groups = ENTRY.exec(entry)?.groups as
      | { repo: string; token: string }
      | undefined;
    if (groups !== undefined) {
      entries.push([
        { role: "main", repo: groups.repo.toLowerCase() },
        groups.token,
      ]);
    }
  }
  return entries;
}

// Compares digests rather than the tokens, so the comparison's timing says
// nothing an attacker can use about the secret.
function digestOf(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}
