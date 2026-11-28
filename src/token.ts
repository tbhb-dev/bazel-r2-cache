// SPDX-License-Identifier: Apache-2.0
// Copyright Tony Burns

/**
 * Signed, expiring cache tokens: `<kind>.<payload>.<signature>`, where the
 * payload is the base64url of a JSON object and the signature is over the
 * ASCII text `<kind>.<payload>`. The kind alone picks the algorithm: `ci1` is
 * HMAC-SHA-256 under `CI_TOKEN_SIGNING_SECRET`, `host1` is Ed25519 under
 * `HOST_TOKEN_PUBLIC_KEY`. Nothing in a token names an algorithm.
 */

/** The roles the `ci1` key may sign. */
type SignedRole = "main" | "pr" | "read";

/** The Worker settings the verifier reads. A setting that isn't set is undefined. */
export interface SignedSettings {
  /** The HMAC-SHA-256 key for CI tokens; a Worker secret. */
  readonly CI_TOKEN_SIGNING_SECRET?: string;
  /** The Ed25519 key for host tokens: base64 of the SPKI DER bytes. */
  readonly HOST_TOKEN_PUBLIC_KEY?: string;
  /** The organization's numeric id, as a string. */
  readonly GITHUB_OWNER_ID?: string;
  /** Comma-separated ids of host tokens that are revoked. */
  readonly REVOKED_TOKEN_IDS?: string;
  /** Unix seconds as a string: host tokens issued before it are refused. */
  readonly HOST_TOKENS_ISSUED_AFTER?: string;
}

/** A token's payload. `repo` is lowercase `owner/repo`; `iat` and `exp` are Unix seconds. */
export interface Claims {
  readonly role: SignedRole;
  readonly repo?: string;
  readonly pr?: number;
  readonly aud: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

/** What a good token grants: a main token's repository, or a pr token's repository and number. */
export interface Verified {
  readonly role: SignedRole;
  readonly repo: string | null;
  readonly pr: number | null;
}

const ASCII = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Reads base64url with or without padding, and plain base64. Throws on anything else. */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  const algorithm = { name: "HMAC", hash: "SHA-256" };
  const key = ASCII.encode(secret);
  // Stryker disable BooleanLiteral: nothing observes the flag of a key that stays inside the Worker
  return crypto.subtle.importKey("raw", key, algorithm, false, [usage]);
  // Stryker restore BooleanLiteral
}

async function seal(
  kind: string,
  claims: Claims,
  sign: (data: Uint8Array) => Promise<ArrayBuffer>,
): Promise<string> {
  const head = `${kind}.${toBase64Url(ASCII.encode(JSON.stringify(claims)))}`;
  return `${head}.${toBase64Url(new Uint8Array(await sign(ASCII.encode(head))))}`;
}

/** A `ci1` token for `claims`, signed with the HMAC secret. */
export function signCiToken(claims: Claims, secret: string): Promise<string> {
  return seal("ci1", claims, async (data) =>
    crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), data),
  );
}

// Lowercase `owner/repo`; the exchange endpoint checks the name against GitHub.
const REPO = /^[a-z0-9-]+\/(?!\.{1,2}$)[a-z0-9._-]+$/;

function isRepo(value: unknown): value is string {
  return typeof value === "string" && REPO.test(value);
}

function isPullRequest(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

// The grant for an allowed role, or null when it lacks what the role needs.
function grant(role: unknown, repo: unknown, pr: unknown): Verified | null {
  switch (role) {
    case "main":
      return isRepo(repo) ? { role, repo, pr: null } : null;
    case "pr":
      return isRepo(repo) && isPullRequest(pr) ? { role, repo, pr } : null;
    default:
      return { role: role as SignedRole, repo: null, pr: null };
  }
}

async function check(
  token: string,
  settings: SignedSettings,
  origin: string,
  now: number,
): Promise<Verified | null> {
  const parts = token.split(".");
  // A `host1` token has no verifier yet, so it is always refused.
  if (parts.length !== 3 || parts[0] !== "ci1") {
    return null;
  }
  const secret = settings.CI_TOKEN_SIGNING_SECRET;
  // Stryker disable next-line ConditionalExpression,BlockStatement: importing an empty key throws, which `verifySigned` reads as a refusal too
  if (!secret) {
    return null;
  }
  const [kind, body, signature] = parts as [string, string, string];
  // A payload that isn't a JSON object throws here, which is a refusal.
  const { role, repo, pr, aud, jti, exp } = JSON.parse(
    new TextDecoder().decode(fromBase64(body)),
  ) as Record<string, unknown>;
  // `crypto.subtle.verify` compares in constant time.
  const holds = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    fromBase64(signature),
    ASCII.encode(`${kind}.${body}`),
  );
  if (
    !holds ||
    aud !== origin ||
    typeof exp !== "number" ||
    exp * 1000 <= now ||
    typeof jti !== "string" ||
    !["main", "pr", "read"].includes(role as string)
  ) {
    return null;
  }
  return grant(role, repo, pr);
}

/**
 * The grant of a token that starts with `ci1.` or `host1.`, or null for any
 * failure. `now` is in milliseconds, and a token lapses at its `exp`.
 */
export async function verifySigned(
  token: string,
  settings: SignedSettings,
  origin: string,
  now: number,
): Promise<Verified | null> {
  try {
    return await check(token, settings, origin, now);
  } catch {
    // Text that doesn't decode, or a key that doesn't import, is a refusal.
    return null;
  }
}
