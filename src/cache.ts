// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import { authorize, type Tokens } from "./auth.ts";
import { sha256Hex } from "./digest.ts";
import { type Kind, namespace } from "./keys.ts";

/** The part of an R2 bucket the cache uses. */
export interface BlobStore {
  get(
    key: string,
  ): Promise<{ readonly body: ReadableStream; readonly size: number } | null>;
  head(key: string): Promise<{ readonly size: number } | null>;
  put(key: string, value: ArrayBuffer): Promise<unknown>;
}

export interface CacheEnv extends Tokens {
  readonly CACHE: BlobStore;
}

// Bazel's HTTP cache protocol: the action cache and content-addressable
// storage, each keyed by a lowercase SHA-256 hex digest.
const PATH = /^\/(ac|cas)\/[0-9a-f]{64}$/;

/**
 * The header in which a pull request's workflow names its number, for
 * example `--remote_header=Bazel-Cache-Pull-Request=42`. Only the pr role
 * may send it, and the pr role must.
 */
export const PR_HEADER = "Bazel-Cache-Pull-Request";

const PR_NUMBER = /^[1-9][0-9]{0,8}$/;

function status(
  code: number,
  text: string,
  headers: HeadersInit = {},
): Response {
  return new Response(text, { status: code, headers });
}

/** Serves one Bazel HTTP cache request against `env`. */
export async function handle(
  request: Request,
  env: CacheEnv,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!PATH.test(path)) {
    return status(404, "not found");
  }
  const [, kind, digest] = path.split("/") as [string, Kind, string];
  const role = await authorize(request.headers.get("Authorization"), env);
  if (role === null) {
    return status(401, "unauthorized", { "WWW-Authenticate": "Bearer" });
  }
  const prHeader = request.headers.get(PR_HEADER);
  if ((role === "pr") !== (prHeader !== null)) {
    return status(400, `${PR_HEADER} goes with a pr token, and only with one`);
  }
  if (prHeader !== null && !PR_NUMBER.test(prHeader)) {
    return status(400, `${PR_HEADER} must be a pull request number`);
  }
  // Only the pr role reads the number; the others ignore it.
  const keys = namespace(role, kind, digest, Number(prHeader));
  switch (request.method) {
    case "GET": {
      for (const key of keys.reads) {
        const object = await env.CACHE.get(key);
        if (object !== null) {
          return new Response(object.body, {
            headers: { "Content-Length": String(object.size) },
          });
        }
      }
      return status(404, "not found");
    }
    case "HEAD": {
      for (const key of keys.reads) {
        const object = await env.CACHE.head(key);
        if (object !== null) {
          return new Response(null, {
            headers: { "Content-Length": String(object.size) },
          });
        }
      }
      return new Response(null, { status: 404 });
    }
    case "PUT": {
      if (keys.write === null) {
        return status(403, "forbidden");
      }
      const body = await request.arrayBuffer();
      // A blob is stored under its own digest, so any writer can add one
      // safely; an action cache entry can't be checked this way, so each
      // role writes only its own namespace.
      if (kind === "cas" && (await sha256Hex(body)) !== digest) {
        return status(400, "body does not match its digest");
      }
      await env.CACHE.put(keys.write, body);
      return status(200, "");
    }
    default:
      return status(405, "method not allowed", { Allow: "GET, HEAD, PUT" });
  }
}
