// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

/** The lowercase hex SHA-256 digest of `data`. */
export async function sha256Hex(
  data: ArrayBuffer | Uint8Array,
): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
