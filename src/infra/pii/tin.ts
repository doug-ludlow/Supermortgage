/**
 * The taxpayer identifier at rest (32.18 rule 7; 32.3 E5: "the one typed field — stored once, never echoed"):
 * `application_borrowers.tin_encrypted` (0057, COMMENT 'pii') holds the nine digits under AES-256-GCM as
 * iv ‖ tag ‖ ciphertext — the same shape src/runtime/staff/repo.ts keeps a staff e-mail in. The key is `TIN_CIPHER_KEY`
 * (32 bytes base64/hex, or any passphrase — sha256'd), required in production; outside production a FAKE constant stands
 * in so a deployed demo works without a secret. The only reader is 23.6's assembly (du/emit.ts loadGraph), which puts the
 * value on the Fannie Mae-confidential document and nowhere else; no log line, no borrower payload (serialize.ts
 * FORBIDDEN_FIELDS keeps `tin` / `ssn` / `tin_encrypted` off every /v1/borrower/* response) ever carries it.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const FAKE_TIN_CIPHER_KEY = "FAKE-tin-cipher-key-nonproduction-only";
/** The 32-byte AES key: `TIN_CIPHER_KEY` (required in production), else the FAKE constant. */
export function tinCipherKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = (env["TIN_CIPHER_KEY"] ?? "").trim();
  const environment = env["ENVIRONMENT"] ?? "nonprod";
  if (!raw && (environment === "production" || environment === "prod")) throw new Error("TIN_CIPHER_KEY is not set (32.18 rule 7: the taxpayer-identifier cipher key is required in production)");
  return createHash("sha256").update(raw || FAKE_TIN_CIPHER_KEY).digest();
}
/** The nine digits of an SSN/ITIN (any punctuation dropped); a RangeError when the input is not nine digits — nothing else is ever encrypted here. */
export function tinDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 9) throw new RangeError("a taxpayer identifier is nine digits");
  return digits;
}
export function encryptTin(value: string, key: Buffer): Buffer {
  const digits = tinDigits(value);
  const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(digits, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}
export function decryptTin(blob: Buffer | Uint8Array, key: Buffer): string {
  const b = Buffer.from(blob); const iv = b.subarray(0, 12); const tag = b.subarray(12, 28); const enc = b.subarray(28);
  const d = createDecipheriv("aes-256-gcm", key, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}
