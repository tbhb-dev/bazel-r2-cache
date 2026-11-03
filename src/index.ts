// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import { handle } from "./cache.ts";

/**
 * The response header that names the Worker version that answered, so a
 * deploy's checks can confirm they reached the version they meant to test.
 */
export const VERSION_HEADER = "Bazel-Cache-Worker-Version";

/** The Worker's bindings: the R2 bucket, the token secrets, its version. */
export interface Env {
  readonly CACHE: R2Bucket;
  readonly READ_TOKENS: string;
  readonly MAIN_TOKEN: string;
  readonly PR_TOKEN: string;
  readonly E2E_TOKEN: string;
  readonly CF_VERSION_METADATA: { readonly id: string };
}

export default {
  async fetch(request, env): Promise<Response> {
    const response = await handle(request, env);
    const headers = new Headers(response.headers);
    headers.set(VERSION_HEADER, env.CF_VERSION_METADATA.id);
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;
