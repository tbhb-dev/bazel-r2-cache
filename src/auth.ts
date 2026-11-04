// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import { sha256Hex } from "./digest.ts";

/**
 * What a token may do:
 * - read: read main's action cache and the blobs; developers
 * - main: read and write main's action cache and the blobs; pushes to main
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
}

const BEARER = "Bearer ";

/**
 * The role of the bearer token in an `Authorization` header, or null when
 * the header is missing, malformed, or holds no known token. An unset
 * (empty) secret or list entry never matches.
 */
export async function authorize(
  header: string | null,
  tokens: Tokens,
): Promise<Role | null> {
  if (header?.startsWith(BEARER) !== true) {
    return null;
  }
  const given = await digestOf(header.slice(BEARER.length));
  const candidates: [Role, string][] = [
    ["main", tokens.MAIN_TOKEN],
    ["pr", tokens.PR_TOKEN],
    ["e2e", tokens.E2E_TOKEN],
    ...list("read", tokens.READ_TOKENS),
    ...list("host", tokens.HOST_TOKENS),
  ];
  for (const [role, secret] of candidates) {
    if (secret !== "" && (await digestOf(secret)) === given) {
      return role;
    }
  }
  return null;
}

function list(role: Role, secret: string): [Role, string][] {
  return secret.split(",").map((t) => [role, t.trim()]);
}

// Compares digests rather than the tokens, so the comparison's timing says
// nothing an attacker can use about the secret.
function digestOf(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}
