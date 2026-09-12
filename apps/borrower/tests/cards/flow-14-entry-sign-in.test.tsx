/**
 * 32.14 — what the borrower SEES at the doors (DELTA-12, DELTA-14; the account form itself is 32.16 §2.0 — tests/cards/account.test.tsx).
 * The API facts are asserted in src/domain/borrower/32-14.spec.test.ts; here: the sign-in screen the shell and the deep-link
 * page render on a 401 (`SignIn` = the account form in its sign-in mode under `auth.welcome_back`: e-mail + password, the
 * Google FAKE identity form → `authOidcStart` → the redirect; no code chooser, no passkey — docs/ux/17 §0.4), the Google
 * callback page, the deep-link page (S5/T16: no session → the sign-in form with the token retained; 404/410 → `deep_link.*`
 * with the sign-in offer; another party's token → the API's refusal and no target), the return page, the `?card=` pin, the
 * `auth.passkey.offer` inline action, the `auth.add_mobile` prompt (codes stay for the mobile) and the header's Sign in.
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
import { Header } from "@/components/shell/Header";
import { AddMobilePrompt } from "@/components/shell/AddMobile";
import { Thread, currentAsk } from "@/components/shell/Thread";
import { accountSignIn } from "@/lib/api/account";
import { PENDING_DEEP_LINK } from "@/lib/auth/passkey";
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
vi.mock("@/lib/api/account", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/api/account")>();
  return { ...mod, accountSignIn: vi.fn(), accountCreate: vi.fn(), accountVerifyEmail: vi.fn() };
});

const user = userEvent.setup();
const apiError = (status: number, code: string, copy_key: string) => new ApiRequestError(status, { code, copy_key });
const REDIRECT = "https://demo.supermortgage.com/app/auth/google/callback";
const googleLabel = copy("auth.google.button");
const [continueLabel = ""] = copyOptions("auth.code.enter");
const SESSION = { level: "L1" as const, session: "cookie" as const };

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

/** Sign in with e-mail + password on a rendered SignIn (32.16 §2.0). */
async function signInWithPassword(email = "maya@example.com", password = "correct horse") {
  await user.type(screen.getByLabelText(copy("account.email.field")), email);
  await user.type(screen.getByLabelText(copy("account.password.field")), password);
  await user.click(screen.getByRole("button", { name: copy("account.signin.button") }));
}

describe("32.16 §2.0 — the sign-in screen on a 401 (SignIn = the account form under auth.welcome_back)", () => {
  it("renders e-mail, password, Sign in and Google under auth.welcome_back; no code chooser, no passkey; #otp on the root; no card", () => {
    render(<SignIn onSession={vi.fn()} />);
    expect(screen.getByRole("heading", { name: copy("auth.welcome_back") })).toBeInTheDocument();
    expect(screen.getByLabelText(copy("account.email.field"))).toBeInTheDocument();
    expect(screen.getByLabelText(copy("account.password.field"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy("account.signin.button") })).toHaveClass("sm-btn-primary");
    expect(screen.getByRole("button", { name: googleLabel })).toHaveClass("sm-google-btn");
    for (const gone of copyOptions("auth.welcome_back").filter((o) => o !== googleLabel)) expect(screen.queryByRole("button", { name: gone })).toBeNull(); // Text me a code · E-mail me a code · Use my passkey
    expect(screen.getByRole("link", { name: copy("account.new") })).toHaveAttribute("href", "/sign-up");
    expect(document.getElementById("otp")).toBe(screen.getByTestId("account"));
    expect(screen.getByTestId("account")).toHaveAttribute("data-mode", "sign_in");
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("e-mail + password → accountSignIn → onSession; a wrong password renders auth.password_wrong, never the code", async () => {
    vi.mocked(accountSignIn).mockRejectedValueOnce(apiError(401, "PASSWORD_WRONG", "auth.password_wrong")).mockResolvedValueOnce(SESSION);
    const onSession = vi.fn();
    render(<SignIn onSession={onSession} />);
    await signInWithPassword("maya@example.com", "nope");
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("auth.password_wrong"));
    expect(screen.getByRole("alert")).not.toHaveTextContent("PASSWORD_WRONG");
    expect(onSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: copy("account.signin.button") }));
    await waitFor(() => expect(onSession).toHaveBeenCalledWith(SESSION));
    expect(accountSignIn).toHaveBeenLastCalledWith("maya@example.com", "nope");
  });

  it("Continue with Google (FAKE mode): the FAKE identity form becomes the start hint; the app navigates to authorization_url; the deep-link token is retained", async () => {
    vi.mocked(api.authOidcStart).mockResolvedValue({ authorization_url: "/app/auth/google/callback?code=FAKE-1&state=st-1", state: "st-1", expires_at: "x" });
    const navigate = vi.fn();
    render(<SignIn onSession={vi.fn()} navigate={navigate} redirectUri={REDIRECT} deepLinkToken="tok-1" />);
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
    render(<SignIn onSession={vi.fn()} navigate={vi.fn()} redirectUri={REDIRECT} />);
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
  it("no session → the sign-in form (auth.welcome_back) with the token retained, no card and no loan data; after the sign-in the target card is pinned on /app", async () => {
    vi.mocked(api.deeplink).mockRejectedValueOnce(apiError(401, "AUTH_REQUIRED", "auth.sign_in")).mockResolvedValueOnce({ target: { card_instance_id: "card-9" } });
    vi.mocked(accountSignIn).mockResolvedValue(SESSION);
    const navigate = vi.fn();
    render(<DeepLink token="tok-1" navigate={navigate} />);
    expect(await screen.findByRole("heading", { name: copy("auth.welcome_back") })).toBeInTheDocument();
    expect(screen.getByTestId("deep-link")).toHaveAttribute("data-deep-link-token", "tok-1");
    expect(document.getElementById("otp")).not.toBeNull();
    expect(document.querySelectorAll("article[data-card-kind]")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/\$\d/);
    await signInWithPassword();
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
    expect(within(screen.getByTestId("deep-link-refused")).queryByRole("link")).toBeNull();   // the footer's links (32.16 §1 principle 8) are outside the refusal
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
  it("?card= makes that card the current ask (focused on the rail) over the newest pending one; a resolved card falls back — and the thread shows each card as a reference chip, never a card (32.16 §2.1)", () => {
    const older = makeCard("ChoiceCard", { title: "Older ask", options: [{ id: "a", label: "A" }], command: "x", command_args_by_option: {} }, { card_instance_id: "card-old", created_at: "2026-10-19T10:00:00Z" });
    const newer = makeCard("ChoiceCard", { title: "Newer ask", options: [{ id: "a", label: "A" }], command: "x", command_args_by_option: {} }, { card_instance_id: "card-new", created_at: "2026-10-19T12:00:00Z" });
    const cards = { "card-old": older, "card-new": newer } as Record<string, AnyCardInstance>;
    const messages = [msg({ message_id: "m-old", card_instance_id: "card-old" }), msg({ message_id: "m-new", at: "2026-10-19T12:00:00Z", card_instance_id: "card-new" })];
    expect(currentAsk(cards, undefined, "card-old")?.card_instance_id).toBe("card-old");
    expect(currentAsk({ ...cards, "card-old": { ...older, status: "resolved" } as AnyCardInstance }, undefined, "card-old")?.card_instance_id).toBe("card-new");
    render(<Thread {...threadProps(messages, cards)} currentAskId="card-old" />);
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    const chips = screen.getAllByTestId("reference-chip");
    expect(chips.map((c) => c.getAttribute("data-card-id")).sort()).toEqual(["card-new", "card-old"]);
    expect(chips.find((c) => c.getAttribute("data-card-id") === "card-old")).toHaveTextContent("Older ask →");
  });
  it("T12 (docs/ux/17 §0.4): a {{copy:auth.passkey.offer}} line, should one ever arrive, renders as plain text with no action", () => {
    render(<Thread {...threadProps([msg({ body_text: "{{copy:auth.passkey.offer}}" })])} />);
    expect(screen.queryByTestId("passkey-offer")).toBeNull();
    expect(screen.queryByRole("button", { name: copyOptions("auth.passkey.offer")[0]! })).toBeNull();
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
  it("the header shows Sign in when there is no session, and no phone number (the FAKE placeholder number is gone)", async () => {
    const onSignIn = vi.fn();
    render(<Header fixturesMode={false} onSubjectChange={noop} onOpenRecord={noop} showSignIn onSignIn={onSignIn} />);
    expect(screen.queryByTestId("partner-phone")).toBeNull();
    expect(screen.getByTestId("header").textContent).not.toMatch(/555-0100|☎/);
    await user.click(screen.getByTestId("sign-in-button"));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("fake-banner")).toHaveTextContent("FAKE dev mode");
  });
});
