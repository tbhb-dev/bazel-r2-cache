// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import { handle } from "./cache.ts";

/** The Worker's bindings: the R2 bucket and the token secrets. */
export interface Env {
  readonly CACHE: R2Bucket;
  readonly READ_TOKENS: string;
  readonly MAIN_TOKEN: string;
  readonly PR_TOKEN: string;
  readonly E2E_TOKEN: string;
}

export default {
  fetch(request, env): Promise<Response> {
    return handle(request, env);
  },
} satisfies ExportedHandler<Env>;
