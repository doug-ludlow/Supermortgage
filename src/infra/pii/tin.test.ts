// The taxpayer identifier at rest (src/infra/pii/tin.ts): AES-256-GCM iv ‖ tag ‖ ciphertext under TIN_CIPHER_KEY, the FAKE key outside production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decryptTin, encryptTin, FAKE_TIN_CIPHER_KEY, tinCipherKey, tinDigits } from "./tin.ts";

test("tin: nine digits round-trip under the key; the blob is iv (12) ‖ tag (16) ‖ ciphertext (9) and never the digits", () => {
  const key = tinCipherKey({ TIN_CIPHER_KEY: "unit-test-passphrase" });
  const blob = encryptTin("123-45-6789", key);
  assert.equal(blob.length, 12 + 16 + 9);
  assert.equal(decryptTin(blob, key), "123456789");
  assert.ok(!blob.toString("latin1").includes("123456789") && !blob.toString("hex").includes("313233343536373839"), "the digits are not in the blob");
  assert.notDeepEqual(encryptTin("123456789", key), blob, "a fresh iv every time");
});

test("tin: another key (or a tampered blob) cannot read it; a value that is not nine digits is refused before anything is encrypted", () => {
  const key = tinCipherKey({ TIN_CIPHER_KEY: "one" }); const other = tinCipherKey({ TIN_CIPHER_KEY: "two" });
  const blob = encryptTin("123456789", key);
  assert.throws(() => decryptTin(blob, other));
  const tampered = Buffer.from(blob); tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
  assert.throws(() => decryptTin(tampered, key));
  assert.throws(() => encryptTin("12345678", key), RangeError);
  assert.throws(() => tinDigits("abc"), RangeError);
  assert.equal(tinDigits(" 123 45 6789 "), "123456789");
});

test("tin: the key is TIN_CIPHER_KEY sha256'd; unset it is the FAKE constant outside production and a refusal in production", () => {
  assert.deepEqual(tinCipherKey({}), tinCipherKey({ TIN_CIPHER_KEY: FAKE_TIN_CIPHER_KEY }));
  assert.notDeepEqual(tinCipherKey({ TIN_CIPHER_KEY: "prod-secret" }), tinCipherKey({}));
  assert.throws(() => tinCipherKey({ ENVIRONMENT: "production" }), /TIN_CIPHER_KEY is not set/);
  assert.doesNotThrow(() => tinCipherKey({ ENVIRONMENT: "production", TIN_CIPHER_KEY: "prod-secret" }));
});
