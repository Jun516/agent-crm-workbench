import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
/** Authenticated encryption also conceals positions skipped by source RLS.
 * Binding prevents reuse across people, tenants, contacts or list filters. */
export interface MemoryCursorBinding {
  org: string;
  actor: string;
  contact: string;
  resource: string;
  filter?: string;
}
const key = (secret: string) =>
  createHash("sha256").update("crm-customer-memory-cursor:v1\0").update(secret).digest();
const aad = (b: MemoryCursorBinding) =>
  Buffer.from(JSON.stringify([b.org, b.actor, b.contact, b.resource, b.filter ?? ""]));
export function encodeMemoryCursor(value: unknown, binding: MemoryCursorBinding, secret: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(aad(binding));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}
export function decodeMemoryCursor(
  token: string,
  binding: MemoryCursorBinding,
  secret: string,
): unknown {
  try {
    if (token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length < 29 || bytes.toString("base64url") !== token) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key(secret), bytes.subarray(0, 12));
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"),
    );
  } catch {
    throw new Error("memory_cursor_invalid");
  }
}
