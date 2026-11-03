// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import { sha256Hex } from "./digest.ts";

/** What a token may do: read entries, or read and write them. */
export type Role = "read" | "write";

/** The Worker secrets that hold the bearer tokens. */
export interface Tokens {
  readonly READ_TOKEN: string;
  readonly WRITE_TOKEN: string;
}

const BEARER = "Bearer ";

/**
 * The role of the bearer token in an `Authorization` header, or null when
 * the header is missing, malformed, or holds no known token. An unset
 * (empty) secret never matches.
 */
export async function authorize(
  header: string | null,
  tokens: Tokens,
): Promise<Role | null> {
  if (header?.startsWith(BEARER) !== true) {
    return null;
  }
  const token = header.slice(BEARER.length);
  if (await matches(token, tokens.WRITE_TOKEN)) {
    return "write";
  }
  if (await matches(token, tokens.READ_TOKEN)) {
    return "read";
  }
  return null;
}

// Compares digests rather than the tokens, so the comparison's timing says
// nothing an attacker can use about the secret.
async function matches(token: string, secret: string): Promise<boolean> {
  if (secret === "") {
    return false;
  }
  const encoder = new TextEncoder();
  const [given, expected] = await Promise.all([
    sha256Hex(encoder.encode(token)),
    sha256Hex(encoder.encode(secret)),
  ]);
  return given === expected;
}
