// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import type { Role } from "./auth.ts";

/** Bazel's two stores: the action cache and content-addressable storage. */
export type Kind = "ac" | "cas";

/**
 * Where a role reads and writes. R2 lifecycle rules in the ops repository
 * expire each of these prefixes, and nothing else, so a key outside them
 * would never expire.
 */
export interface Namespace {
  /** The keys to try for a read, in order; empty when the role can't read. */
  readonly reads: readonly string[];
  /** The key to write, or null when the role can't write. */
  readonly write: string | null;
}

/**
 * The keys a role uses for one entry. `pr` is the pull request number,
 * which only the pr role uses.
 */
export function namespace(
  role: Role,
  kind: Kind,
  digest: string,
  pr: number,
): Namespace {
  if (role === "e2e") {
    const key = `e2e/${kind}/${digest}`;
    return { reads: [key], write: key };
  }
  // Blobs are one shared pool: the Worker checks each upload's digest.
  if (kind === "cas") {
    const key = `cas/${digest}`;
    return { reads: [key], write: role === "read" ? null : key };
  }
  const main = `ac/main/${digest}`;
  if (role === "pr") {
    const own = `ac/pr/${String(pr)}/${digest}`;
    return { reads: [own, main], write: own };
  }
  return { reads: [main], write: role === "main" ? main : null };
}
