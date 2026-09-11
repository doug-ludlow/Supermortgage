/**
 * A minimal WebAuthn (passkey) server-side verifier — no external package (the root package.json has none, and the
 * platform keeps its vendor surface to ports with fakes). Implemented for real: CBOR decoding of the attestation object,
 * the authenticator data layout, COSE (EC2 P-256 / RSA) → JWK, rpIdHash / flags / signCount checks, and signature
 * verification of an assertion (ES256, RS256) with node:crypto. NOT implemented — marked FAKE: the attestation statement
 * itself (`fmt` other than `none`) is accepted without verifying its certificate chain. TODO: swap this module for
 * `@simplewebauthn/server` (verifyRegistrationResponse / verifyAuthenticationResponse) when attestation policy matters.
 */
import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

export const ATTESTATION_VERIFICATION = "FAKE" as const;   // attStmt is not verified — see the module comment
export const COSE_ES256 = -7; export const COSE_RS256 = -257;

export const b64url = { encode: (b: Buffer | Uint8Array): string => Buffer.from(b).toString("base64url"), decode: (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64") };
export const sha256 = (b: Buffer | string): Buffer => createHash("sha256").update(b).digest();

// ───────────────────────────── CBOR (the subset attestation objects and COSE keys use)
type CborValue = number | bigint | string | Buffer | CborValue[] | Map<CborValue, CborValue> | boolean | null | undefined;
export function decodeCbor(buf: Buffer): { value: CborValue; rest: Buffer } {
  let pos = 0;
  const read = (n: number): Buffer => { if (pos + n > buf.length) throw new RangeError("CBOR: truncated"); const b = buf.subarray(pos, pos + n); pos += n; return b; };
  const arg = (ai: number): number | bigint => {
    if (ai < 24) return ai;
    if (ai === 24) return read(1)[0]!;
    if (ai === 25) return read(2).readUInt16BE(0);
    if (ai === 26) return read(4).readUInt32BE(0);
    if (ai === 27) return read(8).readBigUInt64BE(0);
    throw new RangeError(`CBOR: unsupported additional info ${ai}`);
  };
  const item = (): CborValue => {
    const ib = read(1)[0]!; const major = ib >> 5; const ai = ib & 0x1f;
    switch (major) {
      case 0: return arg(ai);
      case 1: { const a = arg(ai); return typeof a === "bigint" ? -1n - a : -1 - a; }
      case 2: return Buffer.from(read(Number(arg(ai))));
      case 3: return read(Number(arg(ai))).toString("utf8");
      case 4: { const n = Number(arg(ai)); const out: CborValue[] = []; for (let i = 0; i < n; i++) out.push(item()); return out; }
      case 5: { const n = Number(arg(ai)); const m = new Map<CborValue, CborValue>(); for (let i = 0; i < n; i++) { const k = item(); m.set(k, item()); } return m; }
      case 7: if (ai === 20) return false; if (ai === 21) return true; if (ai === 22) return null; if (ai === 23) return undefined; throw new RangeError("CBOR: unsupported simple value");
      default: throw new RangeError(`CBOR: unsupported major type ${major}`);
    }
  };
  const value = item();
  return { value, rest: buf.subarray(pos) };
}
const mapGet = (m: CborValue, key: number | string): CborValue => { if (!(m instanceof Map)) throw new RangeError("CBOR: expected a map"); for (const [k, v] of m) if (k === key || (typeof k === "bigint" && Number(k) === key)) return v; return undefined; };

// ───────────────────────────── COSE key → JWK
export interface PublicKeyRecord { readonly jwk: Record<string, string>; readonly algorithm: number; }
export function coseToJwk(cose: CborValue): PublicKeyRecord {
  const kty = Number(mapGet(cose, 1)); const alg = Number(mapGet(cose, 3));
  if (kty === 2) {   // EC2
    const crv = Number(mapGet(cose, -1)); const x = mapGet(cose, -2); const y = mapGet(cose, -3);
    if (crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y)) throw new RangeError("COSE: only P-256 EC2 keys are supported");
    if (alg !== COSE_ES256) throw new RangeError(`COSE: unsupported EC alg ${alg}`);
    return { jwk: { kty: "EC", crv: "P-256", x: b64url.encode(x), y: b64url.encode(y) }, algorithm: alg };
  }
  if (kty === 3) {   // RSA
    const n = mapGet(cose, -1); const e = mapGet(cose, -2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new RangeError("COSE: malformed RSA key");
    if (alg !== COSE_RS256) throw new RangeError(`COSE: unsupported RSA alg ${alg}`);
    return { jwk: { kty: "RSA", n: b64url.encode(n), e: b64url.encode(e) }, algorithm: alg };
  }
  throw new RangeError(`COSE: unsupported key type ${kty}`);
}
export const keyFromJwk = (jwk: Record<string, unknown>): KeyObject => createPublicKey({ key: jwk as never, format: "jwk" });

// ───────────────────────────── authenticator data
export interface AuthenticatorData { readonly rpIdHash: Buffer; readonly flags: number; readonly userPresent: boolean; readonly userVerified: boolean; readonly signCount: number; readonly credentialId?: Buffer; readonly credentialPublicKey?: CborValue; readonly raw: Buffer; }
export function parseAuthenticatorData(raw: Buffer): AuthenticatorData {
  if (raw.length < 37) throw new RangeError("authenticatorData: too short");
  const flags = raw[32]!;
  const base = { rpIdHash: raw.subarray(0, 32), flags, userPresent: (flags & 0x01) !== 0, userVerified: (flags & 0x04) !== 0, signCount: raw.readUInt32BE(33), raw };
  if ((flags & 0x40) === 0) return base;   // no attested credential data
  const idLen = raw.readUInt16BE(53);
  const credentialId = raw.subarray(55, 55 + idLen);
  const { value: credentialPublicKey } = decodeCbor(raw.subarray(55 + idLen));
  return { ...base, credentialId, credentialPublicKey };
}

export interface ClientData { readonly type: string; readonly challenge: string; readonly origin: string; }
export function parseClientData(clientDataJSON: string): ClientData {
  const j = JSON.parse(b64url.decode(clientDataJSON).toString("utf8")) as Partial<ClientData>;
  if (typeof j.type !== "string" || typeof j.challenge !== "string" || typeof j.origin !== "string") throw new RangeError("clientDataJSON: type, challenge and origin are required");
  return { type: j.type, challenge: j.challenge, origin: j.origin };
}
const originAllowed = (origin: string, rpId: string, allowed: readonly string[]): boolean => { if (allowed.includes(origin)) return true; try { const h = new URL(origin).hostname; return h === rpId || h.endsWith(`.${rpId}`); } catch { return false; } };

// ───────────────────────────── registration
export interface RegistrationInput { readonly rpId: string; readonly allowedOrigins?: readonly string[]; readonly expectedChallenge: string; readonly credential: { id: string; response: { clientDataJSON: string; attestationObject: string; transports?: readonly string[] } }; }
export interface RegistrationResult { readonly credentialId: string; readonly publicKey: PublicKeyRecord; readonly signCount: number; readonly attestationFormat: string; readonly attestationVerified: typeof ATTESTATION_VERIFICATION; readonly transports: readonly string[]; }
export function verifyRegistration(i: RegistrationInput): RegistrationResult {
  const cd = parseClientData(i.credential.response.clientDataJSON);
  if (cd.type !== "webauthn.create") throw new RangeError("registration: clientData.type must be webauthn.create");
  if (cd.challenge !== i.expectedChallenge) throw new RangeError("registration: challenge mismatch");
  if (!originAllowed(cd.origin, i.rpId, i.allowedOrigins ?? [])) throw new RangeError(`registration: origin ${cd.origin} not allowed for rpId ${i.rpId}`);
  const { value: att } = decodeCbor(b64url.decode(i.credential.response.attestationObject));
  const fmt = mapGet(att, "fmt"); const authDataRaw = mapGet(att, "authData");
  if (typeof fmt !== "string" || !Buffer.isBuffer(authDataRaw)) throw new RangeError("attestationObject: fmt and authData are required");
  const ad = parseAuthenticatorData(authDataRaw);
  if (!ad.rpIdHash.equals(sha256(i.rpId))) throw new RangeError("registration: rpIdHash mismatch");
  if (!ad.userPresent) throw new RangeError("registration: user presence flag not set");
  if (!ad.credentialId || ad.credentialPublicKey === undefined) throw new RangeError("registration: no attested credential data");
  const credentialId = b64url.encode(ad.credentialId);
  if (credentialId !== i.credential.id) throw new RangeError("registration: credential id mismatch");
  // FAKE: attStmt (packed / tpm / android-key / fido-u2f / apple) is not verified — TODO @simplewebauthn/server verifyRegistrationResponse
  return { credentialId, publicKey: coseToJwk(ad.credentialPublicKey), signCount: ad.signCount, attestationFormat: fmt, attestationVerified: ATTESTATION_VERIFICATION, transports: [...(i.credential.response.transports ?? [])] };
}

// ───────────────────────────── assertion
export interface AssertionInput { readonly rpId: string; readonly allowedOrigins?: readonly string[]; readonly expectedChallenge: string; readonly publicKeyJwk: Record<string, unknown>; readonly algorithm: number; readonly storedSignCount: bigint; readonly credential: { id: string; response: { clientDataJSON: string; authenticatorData: string; signature: string } }; }
export function verifyAssertion(i: AssertionInput): { signCount: bigint; userVerified: boolean } {
  const cd = parseClientData(i.credential.response.clientDataJSON);
  if (cd.type !== "webauthn.get") throw new RangeError("assertion: clientData.type must be webauthn.get");
  if (cd.challenge !== i.expectedChallenge) throw new RangeError("assertion: challenge mismatch");
  if (!originAllowed(cd.origin, i.rpId, i.allowedOrigins ?? [])) throw new RangeError(`assertion: origin ${cd.origin} not allowed for rpId ${i.rpId}`);
  const adRaw = b64url.decode(i.credential.response.authenticatorData);
  const ad = parseAuthenticatorData(adRaw);
  if (!ad.rpIdHash.equals(sha256(i.rpId))) throw new RangeError("assertion: rpIdHash mismatch");
  if (!ad.userPresent) throw new RangeError("assertion: user presence flag not set");
  const signed = Buffer.concat([adRaw, sha256(b64url.decode(i.credential.response.clientDataJSON))]);
  const key = keyFromJwk(i.publicKeyJwk);
  const sig = b64url.decode(i.credential.response.signature);
  const ok = i.algorithm === COSE_ES256 ? cryptoVerify("sha256", signed, { key, dsaEncoding: "der" }, sig) : i.algorithm === COSE_RS256 ? cryptoVerify("sha256", signed, key, sig) : false;
  if (!ok) throw new RangeError("assertion: signature did not verify");
  const count = BigInt(ad.signCount);
  if (count !== 0n && count <= i.storedSignCount) throw new RangeError("assertion: signCount did not advance (cloned authenticator?)");
  return { signCount: count, userVerified: ad.userVerified };
}
