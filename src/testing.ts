// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

import type { BlobStore } from "./cache.ts";

/** An in-memory BlobStore for tests. */
export class MemoryStore implements BlobStore {
  readonly objects = new Map<string, Uint8Array>();

  get(key: string): Promise<{ body: ReadableStream; size: number } | null> {
    const value = this.objects.get(key);
    return Promise.resolve(
      value === undefined
        ? null
        : { body: new Blob([value]).stream(), size: value.byteLength },
    );
  }

  head(key: string): Promise<{ size: number } | null> {
    const value = this.objects.get(key);
    return Promise.resolve(
      value === undefined ? null : { size: value.byteLength },
    );
  }

  put(key: string, value: ArrayBuffer): Promise<null> {
    this.objects.set(key, new Uint8Array(value));
    return Promise.resolve(null);
  }
}
