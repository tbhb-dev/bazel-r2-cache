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
 * The keys a role uses for one entry. `pr` is the pull request, as
 * `owner/repo/number` in lowercase, which only the pr role uses; without
 * one, the pr role only reads main's entries. A bound main token reads and
 * writes only `ac/main/<owner>/<repo>/`, and the pr role reads its repository's
 * part of main before the shared part. `repo` is `owner/repo` for a bound main
 * token or for a read or host request. For read and host requests it adds the
 * repository's main action cache as the first read, with no effect on writes.
 */
export function namespace(
  role: Role,
  kind: Kind,
  digest: string,
  pr: string | null,
  repo: string | null = null,
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
  if (role === "main" && repo !== null) {
    const key = `ac/main/${repo}/${digest}`;
    return { reads: [key], write: key };
  }
  if (role === "pr" && pr !== null) {
    const own = `ac/pr/${pr}/${digest}`;
    const prRepo = pr.split("/").slice(0, 2).join("/");
    return { reads: [own, `ac/main/${prRepo}/${digest}`, main], write: own };
  }
  if (role === "read" || role === "host") {
    const reads = repo === null ? [main] : [`ac/main/${repo}/${digest}`, main];
    if (role === "read") {
      return { reads, write: null };
    }
    // Hosts share their results with each other, but nothing else reads
    // them, so a host's result never reaches CI or a deploy.
    const host = `ac/host/${digest}`;
    return { reads: [...reads, host], write: host };
  }
  return { reads: [main], write: role === "main" ? main : null };
}
