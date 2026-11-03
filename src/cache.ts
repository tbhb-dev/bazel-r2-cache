// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import { authorize, type Tokens } from "./auth.ts";
import { sha256Hex } from "./digest.ts";

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
  const [, kind, digest] = path.split("/") as [string, string, string];
  const role = await authorize(request.headers.get("Authorization"), env);
  if (role === null) {
    return status(401, "unauthorized", { "WWW-Authenticate": "Bearer" });
  }
  const key = `${kind}/${digest}`;
  switch (request.method) {
    case "GET": {
      const object = await env.CACHE.get(key);
      if (object === null) {
        return status(404, "not found");
      }
      return new Response(object.body, {
        headers: { "Content-Length": String(object.size) },
      });
    }
    case "HEAD": {
      const object = await env.CACHE.head(key);
      if (object === null) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, {
        headers: { "Content-Length": String(object.size) },
      });
    }
    case "PUT": {
      if (role !== "write") {
        return status(403, "forbidden");
      }
      const body = await request.arrayBuffer();
      // A blob is stored under its own digest, so any writer can add one
      // safely; an action cache entry can't be checked this way.
      if (kind === "cas" && (await sha256Hex(body)) !== digest) {
        return status(400, "body does not match its digest");
      }
      await env.CACHE.put(key, body);
      return status(200, "");
    }
    default:
      return status(405, "method not allowed", { Allow: "GET, HEAD, PUT" });
  }
}
