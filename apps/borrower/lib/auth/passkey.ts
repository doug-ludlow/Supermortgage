/**
 * 32.14 §3 — the passkey path in the browser (WebAuthn) against the existing API (POST /v1/borrower/auth/passkey:
 * register_options → register; assert_options → assert — src/runtime/borrower/routes.ts). The server verifies; this file only
 * shapes the options, base64url-encodes the credential, and remembers that THIS device registered a passkey (a localStorage
 * hint the sign-in screen reads to offer Use my passkey first — 32.14-T12). It never stores a credential, a key or a token.
 * The pending deep link (S5) survives the Google round trip in sessionStorage.
 */
import { api } from "@/lib/api/client";

export const PASSKEY_DEVICE_HINT = "sm_passkey_device";
export const PENDING_DEEP_LINK = "sm_pending_deep_link";

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback; // storage unavailable (private window, SSR)
  }
}

export const hasPasskeyOnDevice = (): boolean => safe(() => window.localStorage.getItem(PASSKEY_DEVICE_HINT) === "1", false);
export const rememberPasskeyOnDevice = (): void => safe(() => window.localStorage.setItem(PASSKEY_DEVICE_HINT, "1"), undefined);
export const setPendingDeepLink = (token: string): void => safe(() => window.sessionStorage.setItem(PENDING_DEEP_LINK, token), undefined);
export const takePendingDeepLink = (): string | null =>
  safe(() => {
    const t = window.sessionStorage.getItem(PENDING_DEEP_LINK);
    if (t) window.sessionStorage.removeItem(PENDING_DEEP_LINK);
    return t;
  }, null);

export function b64urlEncode(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes = ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "="));
  const out = new Uint8Array(new ArrayBuffer(b.length));
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

/** The API's `passkey_options` shape (serialize.ts allow-list). */
type PasskeyOptions = {
  challenge_id: string;
  challenge: string;
  rp: { id: string; name: string };
  user?: { id: string; name: string; display_name: string };
  pub_key_cred_params?: { type: "public-key"; alg: number }[];
  timeout_ms?: number;
  attestation?: AttestationConveyancePreference;
  allow_credentials?: { id: string; type: "public-key"; transports?: AuthenticatorTransport[] }[];
};

export type PasskeySession = { level: string; session: "cookie"; expires_at?: string };

/** Register a passkey on this device for the signed-in party (after the API's `auth.passkey.offer` line). */
export async function passkeyRegister(): Promise<{ passkey_id: string }> {
  const o = (await api.authPasskey({ action: "register_options" })) as unknown as PasskeyOptions;
  if (!o.user) throw new Error("register_options without a user");
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: b64urlDecode(o.challenge),
      rp: o.rp,
      user: { id: b64urlDecode(o.user.id), name: o.user.name, displayName: o.user.display_name },
      pubKeyCredParams: o.pub_key_cred_params ?? [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      timeout: o.timeout_ms,
      attestation: o.attestation ?? "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("no credential");
  const r = cred.response as AuthenticatorAttestationResponse;
  const transports = typeof r.getTransports === "function" ? r.getTransports() : [];
  const out = (await api.authPasskey({
    action: "register",
    challenge_id: o.challenge_id,
    credential: { id: cred.id, response: { clientDataJSON: b64urlEncode(r.clientDataJSON), attestationObject: b64urlEncode(r.attestationObject), transports } },
  })) as { passkey_id: string };
  rememberPasskeyOnDevice();
  return out;
}

/** Sign in with the passkey this device holds: an L1 session without a code (no last_l1_at — the fresh-L1 rule is unchanged). */
export async function passkeyAssert(): Promise<PasskeySession> {
  const o = (await api.authPasskey({ action: "assert_options" })) as unknown as PasskeyOptions;
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: b64urlDecode(o.challenge),
      rpId: o.rp.id,
      allowCredentials: (o.allow_credentials ?? []).map((c) => ({ id: b64urlDecode(c.id), type: "public-key" as const, transports: c.transports })),
      timeout: o.timeout_ms,
      userVerification: "preferred",
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("no credential");
  const r = cred.response as AuthenticatorAssertionResponse;
  return (await api.authPasskey({
    action: "assert",
    challenge_id: o.challenge_id,
    credential: { id: cred.id, response: { clientDataJSON: b64urlEncode(r.clientDataJSON), authenticatorData: b64urlEncode(r.authenticatorData), signature: b64urlEncode(r.signature) } },
  })) as PasskeySession;
}
