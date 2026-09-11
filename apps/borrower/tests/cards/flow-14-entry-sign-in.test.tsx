/**
 * 32.14 — what the borrower SEES at the doors (Phase 1: DELTA-12, DELTA-14). The API facts are asserted in
 * src/domain/borrower/32-14.spec.test.ts; here: the sign-in screen (S3/S6 — the chooser under `auth.choose_method` and
 * `auth.welcome_back`, code entry with the FAKE code marked, resend, the error keys, Use my passkey first on a device that
 * registered one, the Google FAKE identity form → `authOidcStart` → the redirect, T12), the Google callback page, the deep-link
 * page (S5/T16: no session → the chooser with the token retained; 404/410 → `deep_link.*` with the sign-in offer; another
 * party's token → the API's refusal and no target), the return page, the `?card=` pin, the `auth.passkey.offer` inline
 * action, the `auth.add_mobile` prompt and the header's partner phone + Sign in.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiRequestError } from "@/lib/api/client";
import { copy, copyExtra, copyOptions } from "@/lib/copy";
import { SignIn } from "@/components/shell/SignIn";
import { DeepLink, appRoute } from "@/components/shell/DeepLink";
import { GoogleCallback } from "@/components/shell/GoogleCallback";
import { ReturnRedirect } from "@/components/shell/ReturnRedirect";
import { Header, FAKE_SERVICER_CONTACT } from "@/components/shell/Header";
import { AddMobilePrompt } from "@/components/shell/AddMobile";
import { Thread } from "@/components/shell/Thread";
import { PASSKEY_DEVICE_HINT, PENDING_DEEP_LINK, b64urlDecode, b64urlEncode } from "@/lib/auth/passkey";
import type { AnyCardInstance } from "@/lib/types/cards";
import type { ThreadMessage } from "@/lib/types/record";
import { makeCard, TZ } from "./helpers";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/api/client")>();
  return {
    ...mod,
    api: { ...mod.api, authOtpRequest: vi.fn(), authOtpVerify: vi.fn(), authOidcStart: vi.fn(), authOidcCallback: vi.fn(), authPasskey: vi.fn(), deeplink: vi.fn(), command: vi.fn() },
  };
});

const user = userEvent.setup();
const apiError = (status: number, code: string, copy_key: string) => new ApiRequestError(status, { code, copy_key });
const REDIRECT = "https://demo.supermortgage.com/app/auth/google/callback";
const [smsLabel = "", emailLabel = "", googleLabel = "", passkeyLabel = ""] = copyOptions("auth.choose_method");
const [continueLabel = "", resendLabel = ""] = copyOptions("auth.code.enter");

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

/** Walk the SMS code path on a rendered SignIn: request → the FAKE code → verify. */
async function signInWithCode(destination = "(602) 555-0100", code = "246810") {
  await user.click(screen.getByRole("button", { name: smsLabel }));
  await user.type(screen.getByLabelText(copy("auth.sms.field")), destination);
  await user.click(screen.getByRole("button", { name: smsLabel }));
  const field = await screen.findByLabelText(copy("auth.code.enter", { destination }));
  await user.type(field, code);
  await user.click(screen.getByRole("button", { name: continueLabel }));
}

describe("32.14 S3/S6 — the sign-in screen", () => {
  it("renders the chooser under auth.welcome_back: text, e-mail, Google; no passkey without the device hint; the helper line; #otp on the root", () => {
    render(<SignIn variant="welcome_back" onSession={vi.fn()} />);
    expect(screen.getByRole("heading", { name: copy("auth.welcome_back") })).toBeInTheDocument();
    const group = screen.getByRole("group", { name: copy("auth.welcome_back") });
    expect(within(group).getByRole("button", { name: smsLabel })).toHaveClass("sm-btn-primary");
    expect(within(group).getByRole("button", { name: emailLabel })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: googleLabel })).toHaveClass("sm-google-btn");
    expect(within(group).queryByRole("button", { name: passkeyLabel })).toBeNull();
    expect(screen.getByText(copy("entry.identify.why"))).toBeInTheDocument();
    expect(document.getElementById("otp")).toBe(screen.getByTestId("sign-in"));
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("the S3 variant is the same screen under auth.choose_method", () => {
    render(<SignIn variant="choose_method" onSession={vi.fn()} />);
    expect(screen.getByRole("heading", { name: copy("auth.choose_method") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: smsLabel })).toBeInTheDocument();
  });

  it("Text me a code: the mobile field (auth.sms.field) → authOtpRequest(sms) → code entry with the FAKE code marked → authOtpVerify → onSession", async () => {
    vi.mocked(api.authOtpRequest).mockResolvedValue({ challenge_id: "ch-1", delivery: "FAKE", expires_at: "2026-10-20T10:10:00Z", fake_code: "246810" });
    vi.mocked(api.authOtpVerify).mockResolvedValue({ level: "L1", session: "cookie" });
    const onSession = vi.fn();
    render(<SignIn variant="choose_method" onSession={onSession} />);
    await user.click(screen.getByRole("button", { name: smsLabel }));
    expect(screen.getByText(copyExtra("auth.sms.field", "helper")!)).toBeInTheDocument();
    await user.type(screen.getByLabelText(copy("auth.sms.field")), "(602) 555-0100");
    await user.click(screen.getByRole("button", { name: smsLabel }));
    expect(api.authOtpRequest).toHaveBeenCalledWith("sms", "(602) 555-0100");
    const code = await screen.findByLabelText(copy("auth.code.enter", { destination: "(602) 555-0100" }));
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    const fake = screen.getByTestId("fake-code");
    expect(fake).toHaveClass("sm-fake");
    expect(fake).toHaveTextContent("FAKE code · 246810");
    expect(screen.getByRole("button", { name: continueLabel })).toBeDisabled();
    await user.type(code, "246810");
    await user.click(screen.getByRole("button", { name: continueLabel }));
    expect(api.authOtpVerify).toHaveBeenCalledWith("ch-1", "246810");
    await waitFor(() => expect(onSession).toHaveBeenCalledWith({ level: "L1", session: "cookie" }));
  });

  it("E-mail me a code uses auth.email.field and channel email; Send a new code re-requests and shows auth.code.resent", async () => {
    vi.mocked(api.authOtpRequest).mockResolvedValueOnce({ challenge_id: "ch-1", delivery: "FAKE", expires_at: "x" }).mockResolvedValueOnce({ challenge_id: "ch-2", delivery: "FAKE", expires_at: "x" });
    render(<SignIn variant="choose_method" onSession={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: emailLabel }));
    await user.type(screen.getByLabelText(copy("auth.email.field")), "maya@example.com");
    await user.click(screen.getByRole("button", { name: emailLabel }));
    expect(api.authOtpRequest).toHaveBeenCalledWith("email", "maya@example.com");
    await screen.findByLabelText(copy("auth.code.enter", { destination: "maya@example.com" }));
    expect(screen.queryByTestId("fake-code")).toBeNull(); // no fake_code from the API → nothing to show
    await user.click(screen.getByRole("button", { name: resendLabel }));
    expect(await screen.findByTestId("code-resent")).toHaveTextContent(copy("auth.code.resent", { destination: "maya@example.com" }));
    expect(api.authOtpRequest).toHaveBeenCalledTimes(2);
  });

  it("errors render the API's copy key (auth.code_wrong, auth.code_locked), never a code", async () => {
    vi.mocked(api.authOtpRequest).mockResolvedValue({ challenge_id: "ch-1", delivery: "FAKE", expires_at: "x", fake_code: "111111" });
    vi.mocked(api.authOtpVerify).mockRejectedValueOnce(apiError(401, "OTP_INVALID", "auth.code_wrong")).mockRejectedValueOnce(apiError(429, "OTP_TOO_MANY_ATTEMPTS", "auth.code_locked"));
    const onSession = vi.fn();
    render(<SignIn variant="welcome_back" onSession={onSession} />);
    await signInWithCode("(602) 555-0100", "000000");
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("auth.code_wrong"));
    expect(screen.getByRole("alert")).not.toHaveTextContent("OTP_INVALID");
    await user.click(screen.getByRole("button", { name: continueLabel }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("auth.code_locked"));
    expect(onSession).not.toHaveBeenCalled();
  });

  it("T12: Use my passkey is offered FIRST on a device that registered one; the assertion (assert_options → authenticator → assert) opens the session", async () => {
    window.localStorage.setItem(PASSKEY_DEVICE_HINT, "1");
    const cred = { id: "cred-1", response: { clientDataJSON: new Uint8Array([1, 2, 3]).buffer, authenticatorData: new Uint8Array([4]).buffer, signature: new Uint8Array([5, 6]).buffer } };
    Object.defineProperty(window.navigator, "credentials", { value: { get: vi.fn().mockResolvedValue(cred), create: vi.fn() }, configurable: true });
    vi.mocked(api.authPasskey).mockResolvedValueOnce({ challenge_id: "ch-p", challenge: "AQID", rp: { id: "localhost", name: "Supermortgage" }, allow_credentials: [] }).mockResolvedValueOnce({ level: "L1", session: "cookie" });
    const onSession = vi.fn();
    render(<SignIn variant="welcome_back" onSession={onSession} />);
    const group = await screen.findByRole("group", { name: copy("auth.welcome_back") });
    await waitFor(() => expect(within(group).getAllByRole("button")[0]).toHaveTextContent(passkeyLabel));
    expect(within(group).getAllByRole("button")[0]).toHaveClass("sm-btn-primary");
    expect(within(group).getByRole("button", { name: smsLabel })).not.toHaveClass("sm-btn-primary");
    await user.click(within(group).getByRole("button", { name: passkeyLabel }));
    await waitFor(() => expect(onSession).toHaveBeenCalledWith({ level: "L1", session: "cookie" }));
    expect(api.authPasskey).toHaveBeenNthCalledWith(1, { action: "assert_options" });
    expect(api.authPasskey).toHaveBeenNthCalledWith(2, { action: "assert", challenge_id: "ch-p", credential: { id: "cred-1", response: { clientDataJSON: "AQID", authenticatorData: "BA", signature: "BQY" } } });
    expect(Array.from(b64urlDecode(b64urlEncode(new Uint8Array([250, 251, 252]))))).toEqual([250, 251, 252]);
  });

  it("a failed passkey says auth.passkey_failed (use a code instead)", async () => {
    window.localStorage.setItem(PASSKEY_DEVICE_HINT, "1");
    Object.defineProperty(window.navigator, "credentials", { value: { get: vi.fn().mockRejectedValue(new Error("NotAllowedError")), create: vi.fn() }, configurable: true });
    vi.mocked(api.authPasskey).mockResolvedValueOnce({ challenge_id: "ch-p", challenge: "AQID", rp: { id: "localhost", name: "Supermortgage" } });
    render(<SignIn variant="welcome_back" onSession={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: passkeyLabel }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("auth.passkey_failed"));
  });

  it("Continue with Google (FAKE mode): the FAKE identity form becomes the start hint; the app navigates to authorization_url; the deep-link token is retained", async () => {
    vi.mocked(api.authOidcStart).mockResolvedValue({ authorization_url: "/app/auth/google/callback?code=FAKE-1&state=st-1", state: "st-1", expires_at: "x" });
    const navigate = vi.fn();
    render(<SignIn variant="welcome_back" onSession={vi.fn()} navigate={navigate} redirectUri={REDIRECT} deepLinkToken="tok-1" />);
    await user.click(screen.getByRole("button", { name: googleLabel }));
    const form = screen.getByTestId("fake-google");
    expect(within(form).getByText("FAKE Google identity")).toHaveClass("sm-fake");
    await user.type(within(form).getByLabelText(copy("auth.email.field")), "maya@example.com");
    await user.type(within(form).getByLabelText("Name (FAKE profile)"), "Maya Ortiz");
    await user.click(within(form).getByRole("button", { name: googleLabel }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/auth/google/callback?code=FAKE-1&state=st-1"));
    expect(api.authOidcStart).toHaveBeenCalledWith("google", REDIRECT, { email: "maya@example.com", email_verified: true, name: "Maya Ortiz" });
    expect(window.sessionStorage.getItem(PENDING_DEEP_LINK)).toBe("tok-1");
  });

  it("an unverified FAKE claim is passed as email_verified=false; a refused start renders auth.google.failed", async () => {
    vi.mocked(api.authOidcStart).mockRejectedValue(apiError(400, "BAD_REQUEST", "auth.google.failed"));
    render(<SignIn variant="welcome_back" onSession={vi.fn()} navigate={vi.fn()} redirectUri={REDIRECT} />);
    await user.click(screen.getByRole("button", { name: googleLabel }));
    await user.type(screen.getByLabelText(copy("auth.email.field")), "x@example.com");
    await user.click(screen.getByLabelText("email_verified (FAKE claim)"));
    await user.click(within(screen.getByTestId("fake-google")).getByRole("button", { name: googleLabel }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("auth.google.failed"));
    expect(api.authOidcStart).toHaveBeenCalledWith("google", REDIRECT, { email: "x@example.com", email_verified: false });
  });
});

describe("32.14 §3 — the Google callback page", () => {
  it("posts code and state with x-fake-oidc in FAKE mode and resumes the thread", async () => {
    window.history.replaceState({}, "", "/app/auth/google/callback?code=c-1&state=st-1");
    vi.mocked(api.authOidcCallback).mockResolvedValue({ level: "L1", session: "cookie" });
    const navigate = vi.fn();
    render(<GoogleCallback navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app"));
    expect(api.authOidcCallback).toHaveBeenCalledWith("google", "c-1", "st-1", { fake: true });
    expect(screen.getByText("FAKE Google · FakeGoogleOidc")).toHaveClass("sm-fake");
  });
  it("resumes the pending deep link and clears it", async () => {
    window.history.replaceState({}, "", "/app/auth/google/callback?code=c-1&state=st-1");
    window.sessionStorage.setItem(PENDING_DEEP_LINK, "tok-9");
    vi.mocked(api.authOidcCallback).mockResolvedValue({ level: "L1", session: "cookie" });
    const navigate = vi.fn();
    render(<GoogleCallback navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/d/tok-9"));
    expect(window.sessionStorage.getItem(PENDING_DEEP_LINK)).toBeNull();
  });
  it("OIDC_EMAIL_UNVERIFIED / OIDC_INVALID / a missing code → auth.google.failed and the sign-in offer, never the code", async () => {
    window.history.replaceState({}, "", "/app/auth/google/callback?code=c-1&state=st-1");
    vi.mocked(api.authOidcCallback).mockRejectedValue(apiError(401, "OIDC_EMAIL_UNVERIFIED", "auth.google.failed"));
    const navigate = vi.fn();
    const { unmount } = render(<GoogleCallback navigate={navigate} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("auth.google.failed"));
    expect(document.body.textContent).not.toContain("OIDC_EMAIL_UNVERIFIED");
    expect(screen.getByRole("link", { name: copyOptions("deep_link.unknown")[0]! })).toHaveAttribute("href", "/");
    expect(navigate).not.toHaveBeenCalled();
    unmount();
    window.history.replaceState({}, "", "/app/auth/google/callback");
    render(<GoogleCallback navigate={navigate} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("auth.google.failed"));
    expect(api.authOidcCallback).toHaveBeenCalledTimes(1);
  });
});

describe("32.14 S5 — deep links (T16) and the vendor return", () => {
  it("no session → the chooser (auth.welcome_back) with the token retained, no card and no loan data; after the code the target card is pinned on /app", async () => {
    vi.mocked(api.deeplink).mockRejectedValueOnce(apiError(401, "AUTH_REQUIRED", "auth.sign_in")).mockResolvedValueOnce({ target: { card_instance_id: "card-9" } });
    vi.mocked(api.authOtpRequest).mockResolvedValue({ challenge_id: "ch-1", delivery: "FAKE", expires_at: "x", fake_code: "246810" });
    vi.mocked(api.authOtpVerify).mockResolvedValue({ level: "L1", session: "cookie" });
    const navigate = vi.fn();
    render(<DeepLink token="tok-1" navigate={navigate} />);
    expect(await screen.findByRole("heading", { name: copy("auth.welcome_back") })).toBeInTheDocument();
    expect(screen.getByTestId("deep-link")).toHaveAttribute("data-deep-link-token", "tok-1");
    expect(document.getElementById("otp")).not.toBeNull();
    expect(document.querySelectorAll("article[data-card-kind]")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/\$\d/);
    await signInWithCode();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app?card=card-9"));
    expect(api.deeplink).toHaveBeenCalledTimes(2);
    expect(api.deeplink).toHaveBeenLastCalledWith("tok-1");
  });
  it("a document or a route target lands on its page; an absolute route never leaves the app", async () => {
    vi.mocked(api.deeplink).mockResolvedValueOnce({ target: { document_id: "doc-1" } });
    const navigate = vi.fn();
    render(<DeepLink token="tok-2" navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/doc/doc-1"));
    expect(appRoute("/payments")).toBe("/app/payments");
    expect(appRoute("/app/payments")).toBe("/app/payments");
    expect(appRoute("https://evil.example/x")).toBe("/app");
  });
  it("404 → deep_link.unknown and 410 → deep_link.expired, each with the sign-in offer; another party's token → the API's refusal and no target", async () => {
    const navigate = vi.fn();
    vi.mocked(api.deeplink).mockRejectedValueOnce(apiError(404, "DEEP_LINK_UNKNOWN", "deeplink.unknown"));
    const r1 = render(<DeepLink token="nope" navigate={navigate} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("deep_link.unknown"));
    expect(screen.getByRole("link", { name: copyOptions("deep_link.unknown")[0]! })).toBeInTheDocument();
    r1.unmount();
    vi.mocked(api.deeplink).mockRejectedValueOnce(apiError(410, "DEEP_LINK_EXPIRED", "deeplink.expired"));
    const r2 = render(<DeepLink token="old" navigate={navigate} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("deep_link.expired"));
    expect(screen.getByRole("link", { name: copyOptions("deep_link.expired")[0]! })).toBeInTheDocument();
    r2.unmount();
    vi.mocked(api.deeplink).mockRejectedValueOnce(apiError(403, "PARTY_SCOPE", "error.not_yours"));
    render(<DeepLink token="theirs" navigate={navigate} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("error.not_yours"));
    expect(screen.queryByRole("link")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("PARTY_SCOPE");
  });
  it("/return/{vendor}/{card} sends the borrower to /app/?card= with the FAKE vendor marker; the card's state is not touched here", async () => {
    const navigate = vi.fn();
    render(<ReturnRedirect vendor="truv" card="card-r3-truv" navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app?card=card-r3-truv"));
    expect(screen.getByText("FAKE vendor · truv")).toHaveClass("sm-fake");
    expect(api.command).not.toHaveBeenCalled();
  });
});

const noop = () => {};
const msg = (over: Partial<ThreadMessage>): ThreadMessage => ({ message_id: "m-1", conversation_id: "c-1", at: "2026-10-19T14:00:00.000Z", sender: "agent", sender_label: "Supermortgage", channel: "app", subject: {}, voice_turn: false, delivery: { sent: true, delivered: true, read: false }, ...over });
const threadProps = (messages: ThreadMessage[], cards: Record<string, AnyCardInstance> = {}) => ({ messages, cards, timezone: TZ, partnerLegalName: "Partner Bank", showSubjectLabels: false, wide: false, cardProps: { onOpen: noop, onLaunchVendor: async () => ({ vendor_session_id: "vs-FAKE" }), onUpload: async () => ({ document_id: "doc-FAKE" }) }, resolve: async () => {}, cardErrors: {} });

describe("32.14 — the thread: ?card= pins, the passkey offer line", () => {
  it("pinnedId makes that card the pinned ask over the newest pending one; a resolved card falls back", () => {
    const older = makeCard("ChoiceCard", { title: "Older ask", options: [{ id: "a", label: "A" }], command: "x", command_args_by_option: {} }, { card_instance_id: "card-old", created_at: "2026-10-19T10:00:00Z" });
    const newer = makeCard("ChoiceCard", { title: "Newer ask", options: [{ id: "a", label: "A" }], command: "x", command_args_by_option: {} }, { card_instance_id: "card-new", created_at: "2026-10-19T12:00:00Z" });
    const cards = { "card-old": older, "card-new": newer } as Record<string, AnyCardInstance>;
    const messages = [msg({ message_id: "m-old", card_instance_id: "card-old" }), msg({ message_id: "m-new", at: "2026-10-19T12:00:00Z", card_instance_id: "card-new" })];
    const { rerender } = render(<Thread {...threadProps(messages, cards)} pinnedId="card-old" />);
    expect(screen.getByTestId("pinned-ask")).toHaveAttribute("data-pinned-card", "card-old");
    expect(screen.getByTestId("pinned-ask")).toHaveTextContent("Older ask");
    rerender(<Thread {...threadProps(messages, { ...cards, "card-old": { ...older, status: "resolved" } as AnyCardInstance })} pinnedId="card-old" />);
    expect(screen.getByTestId("pinned-ask")).toHaveAttribute("data-pinned-card", "card-new");
  });
  it("T12: the API's {{copy:auth.passkey.offer}} line renders the library sentence and an inline Add a passkey action that runs the registration; Not now dismisses it", async () => {
    const onAddPasskey = vi.fn().mockResolvedValue(undefined);
    const [addLabel = "", notNowLabel = ""] = copyOptions("auth.passkey.offer");
    render(<Thread {...threadProps([msg({ body_text: "{{copy:auth.passkey.offer}}" })])} onAddPasskey={onAddPasskey} />);
    expect(screen.getByText(copy("auth.passkey.offer"))).toBeInTheDocument();
    expect(screen.queryByRole("article")).toBeNull(); // no card
    await user.click(screen.getByRole("button", { name: addLabel }));
    expect(onAddPasskey).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("passkey-added")).toHaveTextContent(addLabel);
    window.sessionStorage.clear();
    render(<Thread {...threadProps([msg({ message_id: "m-2", body_text: "{{copy:auth.passkey.offer}}" })])} onAddPasskey={onAddPasskey} />);
    await user.click(screen.getByRole("button", { name: notNowLabel }));
    expect(screen.queryByRole("button", { name: addLabel })).toBeNull();
    expect(window.sessionStorage.getItem("sm_passkey_offer_done")).toBe("1");
  });
  it("a plain line shows no passkey action", () => {
    render(<Thread {...threadProps([msg({ body_text: "{{copy:entry.disclosure.first}}" })])} onAddPasskey={vi.fn()} />);
    expect(screen.queryByTestId("passkey-offer")).toBeNull();
  });
});

describe("32.14 S3 — auth.add_mobile after Google, and the header", () => {
  it("party.updateContact{phone} then a code to the number; the FAKE code is marked; Not now never blocks", async () => {
    vi.mocked(api.command).mockResolvedValue({});
    vi.mocked(api.authOtpRequest).mockResolvedValue({ challenge_id: "ch-m", delivery: "FAKE", expires_at: "x", fake_code: "135791" });
    vi.mocked(api.authOtpVerify).mockResolvedValue({ level: "L1", session: "cookie" });
    const onDone = vi.fn();
    const first = render(<AddMobilePrompt onDone={onDone} />);
    expect(screen.getByRole("heading", { name: copy("auth.add_mobile") })).toBeInTheDocument();
    expect(screen.getByText(copyExtra("auth.add_mobile", "helper")!)).toBeInTheDocument();
    const [sendLabel = "", notNowLabel = ""] = copyOptions("auth.add_mobile");
    await user.type(screen.getByLabelText(copy("auth.sms.field")), "6025550100");
    await user.click(screen.getByRole("button", { name: sendLabel }));
    await waitFor(() => expect(api.authOtpRequest).toHaveBeenCalledWith("sms", "6025550100"));
    expect(api.command).toHaveBeenCalledWith("party.updateContact", { phone: "6025550100" });
    expect(screen.getByTestId("fake-code")).toHaveTextContent("135791");
    await user.type(screen.getByLabelText(copy("auth.code.enter", { destination: "6025550100" })), "135791");
    await user.click(screen.getByRole("button", { name: continueLabel }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(api.authOtpVerify).toHaveBeenCalledWith("ch-m", "135791");
    expect(window.sessionStorage.getItem("sm_add_mobile_done")).toBe("1");
    first.unmount();
    window.sessionStorage.clear();
    const onDone2 = vi.fn();
    render(<AddMobilePrompt onDone={onDone2} />);
    await user.click(screen.getAllByRole("button", { name: notNowLabel })[0]!);
    expect(onDone2).toHaveBeenCalledTimes(1);
  });
  it("a refusal renders the API's copy key inline and the prompt stays dismissable", async () => {
    vi.mocked(api.command).mockRejectedValue(apiError(403, "FRESH_L1_REQUIRED", "auth.fresh_code"));
    render(<AddMobilePrompt onDone={vi.fn()} />);
    await user.type(screen.getByLabelText(copy("auth.sms.field")), "6025550100");
    await user.click(screen.getByRole("button", { name: copyOptions("auth.add_mobile")[0]! }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("auth.fresh_code"));
    expect(screen.getByRole("button", { name: copyOptions("auth.add_mobile")[1]! })).toBeEnabled();
  });
  it("the header shows the partner's phone as a FAKE-marked tel link and Sign in when there is no session", async () => {
    const onSignIn = vi.fn();
    render(<Header fixturesMode={false} onSubjectChange={noop} onOpenRecord={noop} showSignIn onSignIn={onSignIn} />);
    const phone = screen.getByTestId("partner-phone");
    expect(phone).toHaveAttribute("href", `tel:${FAKE_SERVICER_CONTACT.phone_e164}`);
    expect(phone).toHaveTextContent(FAKE_SERVICER_CONTACT.phone_display);
    expect(within(phone).getByText("FAKE")).toHaveClass("sm-fake");
    await user.click(screen.getByTestId("sign-in-button"));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("fake-banner")).toHaveTextContent("FAKE dev mode");
  });
});
