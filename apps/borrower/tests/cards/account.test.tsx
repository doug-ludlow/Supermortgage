/**
 * 32.16 §2.0 (DELTA-29) — what the borrower SEES on the account screen. The API facts (party_credentials, Argon2id, lockout,
 * the fresh-L1 gate) are asserted in src/domain/borrower/32-16.spec.test.ts; here, with lib/api/account mocked: create → the
 * code step (the FAKE code marked) → verify_email → the session lands on /app; the refusals render their copy keys and never
 * a code (account.exists, account.password_weak, auth.password_wrong, auth.account_locked); EMAIL_UNVERIFIED goes to the code
 * step; the reset flow ends on account.reset.done with the sign-in link; the disclosure line heads the sign-up; passkeys and
 * one-time-code sign-in are offered nowhere.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/client";
import { accountCreate, accountRequestReset, accountReset, accountSignIn, accountVerifyEmail } from "@/lib/api/account";
import { copy, copyExtra, copyOptions } from "@/lib/copy";
import { Account } from "@/components/account/Account";

vi.mock("@/lib/api/account", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/api/account")>();
  return { ...mod, accountCreate: vi.fn(), accountVerifyEmail: vi.fn(), accountSignIn: vi.fn(), accountRequestReset: vi.fn(), accountReset: vi.fn() };
});
vi.mock("@/lib/api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...mod, api: { ...mod.api, authOidcStart: vi.fn() } };
});

const user = userEvent.setup();
const apiError = (status: number, code: string, copy_key: string, extra: Record<string, unknown> = {}) => new ApiRequestError(status, { code, copy_key, ...extra });
const SESSION = { level: "L1" as const, session: "cookie" as const, party: { party_id: "party-1", first_name: "Maya" } };
const [continueLabel = ""] = copyOptions("auth.code.enter");
const EMAIL = "Maya@Example.com";

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

async function fillCredentials(email = EMAIL, password = "correct horse") {
  await user.type(screen.getByLabelText(copy("account.email.field")), email);
  await user.type(screen.getByLabelText(copy("account.password.field")), password);
}

describe("32.16 §2.0 — create an account", () => {
  it("the disclosure line heads the form (partner token filled); e-mail, password with its helper, Create account, Google, the sign-in link; no passkey, no code chooser", () => {
    render(<Account mode="sign_up" partnerLegalName="Saguaro Home Lending, LLC" />);
    expect(screen.getByRole("heading", { name: copy("account.create.title") })).toBeInTheDocument();
    const disclosure = screen.getByTestId("account-disclosure");
    expect(disclosure).toHaveTextContent(copy("entry.disclosure.first", { "partner.legal_name": "Saguaro Home Lending, LLC" }));
    expect(disclosure).not.toHaveTextContent("{{");
    expect(disclosure).toHaveAttribute("data-copy-key", "entry.disclosure.first");
    expect(screen.getByLabelText(copy("account.email.field"))).toHaveAttribute("type", "email");
    expect(screen.getByLabelText(copy("account.password.field"))).toHaveAttribute("type", "password");
    expect(screen.getByText(copyExtra("account.password.field", "helper")!)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy("account.create.button") })).toBeDisabled();
    expect(screen.getByRole("button", { name: copy("auth.google.button") })).toHaveClass("sm-google-btn");
    expect(screen.getByRole("link", { name: copy("account.have_account") })).toHaveAttribute("href", "/sign-in");
    expect(document.getElementById("otp")).toBe(screen.getByTestId("account"));
    expect(screen.queryByText(/passkey/i)).toBeNull();
    expect(screen.queryByRole("button", { name: copyOptions("auth.choose_method")[0]! })).toBeNull(); // "Text me a code" is gone
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("Create account → accountCreate → the code step (account.verify.title, auth.code.enter with the e-mail, the FAKE code marked) → verify_email → /app", async () => {
    vi.mocked(accountCreate).mockResolvedValue({ challenge_id: "ch-1", delivery: "FAKE", expires_at: "2027-01-01T00:00:00Z", fake_code: "246810" });
    vi.mocked(accountVerifyEmail).mockResolvedValue(SESSION);
    const navigate = vi.fn();
    render(<Account mode="sign_up" navigate={navigate} />);
    await fillCredentials();
    await user.click(screen.getByRole("button", { name: copy("account.create.button") }));
    expect(accountCreate).toHaveBeenCalledWith(EMAIL, "correct horse");
    expect(await screen.findByRole("heading", { name: copy("account.verify.title") })).toBeInTheDocument();
    const code = screen.getByLabelText(copy("auth.code.enter", { destination: EMAIL }));
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    const fake = screen.getByTestId("fake-code");
    expect(fake).toHaveClass("sm-fake");
    expect(fake).toHaveTextContent("FAKE code · 246810");
    expect(screen.queryByTestId("account-disclosure")).toBeNull(); // the disclosure line belongs to the form, not the code step
    expect(screen.getByRole("button", { name: continueLabel })).toBeDisabled();
    await user.type(code, "246810");
    await user.click(screen.getByRole("button", { name: continueLabel }));
    expect(accountVerifyEmail).toHaveBeenCalledWith("ch-1", "246810");
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app"));
  });

  it("onSession takes the session instead of the /app landing", async () => {
    vi.mocked(accountCreate).mockResolvedValue({ challenge_id: "ch-1", delivery: "email", expires_at: "x" });
    vi.mocked(accountVerifyEmail).mockResolvedValue(SESSION);
    const onSession = vi.fn();
    const navigate = vi.fn();
    render(<Account mode="sign_up" onSession={onSession} navigate={navigate} />);
    await fillCredentials();
    await user.click(screen.getByRole("button", { name: copy("account.create.button") }));
    expect(screen.queryByTestId("fake-code")).toBeNull(); // no fake_code from the API → nothing to show
    await user.type(await screen.findByLabelText(copy("auth.code.enter", { destination: EMAIL })), "111111");
    await user.click(screen.getByRole("button", { name: continueLabel }));
    await waitFor(() => expect(onSession).toHaveBeenCalledWith(SESSION));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("refusals render the copy key, never the code: ACCOUNT_EXISTS → account.exists; PASSWORD_WEAK → account.password_weak; a wrong code → auth.code_wrong, three times → auth.code_locked and no session", async () => {
    vi.mocked(accountCreate).mockRejectedValueOnce(apiError(409, "ACCOUNT_EXISTS", "account.exists")).mockRejectedValueOnce(apiError(400, "PASSWORD_WEAK", "account.password_weak")).mockResolvedValueOnce({ challenge_id: "ch-1", delivery: "FAKE", expires_at: "x", fake_code: "246810" });
    vi.mocked(accountVerifyEmail).mockRejectedValueOnce(apiError(401, "OTP_INVALID", "auth.code_wrong")).mockRejectedValueOnce(apiError(401, "OTP_INVALID", "auth.code_wrong")).mockRejectedValueOnce(apiError(429, "OTP_TOO_MANY_ATTEMPTS", "auth.code_locked"));
    const navigate = vi.fn();
    render(<Account mode="sign_up" navigate={navigate} />);
    await fillCredentials();
    await user.click(screen.getByRole("button", { name: copy("account.create.button") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("account.exists"));
    expect(screen.getByRole("alert")).not.toHaveTextContent("ACCOUNT_EXISTS");
    await user.click(screen.getByRole("button", { name: copy("account.create.button") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("account.password_weak"));
    await user.click(screen.getByRole("button", { name: copy("account.create.button") }));
    const code = await screen.findByLabelText(copy("auth.code.enter", { destination: EMAIL }));
    for (const expected of ["auth.code_wrong", "auth.code_wrong", "auth.code_locked"]) {
      await user.clear(code);
      await user.type(code, "000000");
      await user.click(screen.getByRole("button", { name: continueLabel }));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(copy(expected)));
    }
    expect(accountVerifyEmail).toHaveBeenCalledTimes(3);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("32.16 §2.0 — sign in", () => {
  it("renders under account.signin.title by default and under a titleKey (auth.welcome_back) on a 401; Forgot → /reset, New here → /sign-up; Back when cancellable", async () => {
    const onCancel = vi.fn();
    const { unmount } = render(<Account mode="sign_in" />);
    expect(screen.getByRole("heading", { name: copy("account.signin.title") })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy("account.forgot") })).toHaveAttribute("href", "/reset");
    expect(screen.getByRole("link", { name: copy("account.new") })).toHaveAttribute("href", "/sign-up");
    expect(screen.getByLabelText(copy("account.password.field"))).toHaveAttribute("autocomplete", "current-password");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByTestId("account-disclosure")).toBeNull();
    unmount();
    render(<Account mode="sign_in" titleKey="auth.welcome_back" onCancel={onCancel} />);
    expect(screen.getByRole("heading", { name: copy("auth.welcome_back") })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copyOptions("auth.welcome_back")[3]! })).toBeNull(); // Use my passkey is not surfaced
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("e-mail + password → accountSignIn → the session; a wrong password says auth.password_wrong; a locked account says auth.account_locked; no session either way", async () => {
    vi.mocked(accountSignIn).mockRejectedValueOnce(apiError(401, "PASSWORD_WRONG", "auth.password_wrong")).mockRejectedValueOnce(apiError(423, "ACCOUNT_LOCKED", "auth.account_locked")).mockResolvedValueOnce(SESSION);
    const onSession = vi.fn();
    render(<Account mode="sign_in" onSession={onSession} />);
    await fillCredentials(EMAIL, "nope");
    await user.click(screen.getByRole("button", { name: copy("account.signin.button") }));
    expect(accountSignIn).toHaveBeenCalledWith(EMAIL, "nope");
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("auth.password_wrong"));
    expect(document.body.textContent).not.toContain("PASSWORD_WRONG");
    await user.click(screen.getByRole("button", { name: copy("account.signin.button") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("auth.account_locked"));
    expect(onSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId("account-code")).toBeNull();
    await user.click(screen.getByRole("button", { name: copy("account.signin.button") }));
    await waitFor(() => expect(onSession).toHaveBeenCalledWith(SESSION));
  });

  it("EMAIL_UNVERIFIED (a fresh code was sent) → the code step with auth.email_unverified and the FAKE code; verify_email opens the session", async () => {
    vi.mocked(accountSignIn).mockRejectedValue(apiError(403, "EMAIL_UNVERIFIED", "auth.email_unverified", { challenge_id: "ch-7", fake_code: "135791" }));
    vi.mocked(accountVerifyEmail).mockResolvedValue(SESSION);
    const navigate = vi.fn();
    render(<Account mode="sign_in" navigate={navigate} />);
    await fillCredentials();
    await user.click(screen.getByRole("button", { name: copy("account.signin.button") }));
    expect(await screen.findByRole("heading", { name: copy("account.verify.title") })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(copy("auth.email_unverified"));
    expect(screen.getByTestId("fake-code")).toHaveTextContent("135791");
    await user.type(screen.getByLabelText(copy("auth.code.enter", { destination: EMAIL })), "135791");
    await user.click(screen.getByRole("button", { name: continueLabel }));
    expect(accountVerifyEmail).toHaveBeenCalledWith("ch-7", "135791");
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app"));
  });
});

describe("32.16 §2.0 — reset a password", () => {
  it("e-mail → request_reset → the code + new password step (account.reset.code, the FAKE code) → reset → account.reset.done with the sign-in link; no session is opened", async () => {
    vi.mocked(accountRequestReset).mockResolvedValue({ ok: true, challenge_id: "ch-r", fake_code: "999000" });
    vi.mocked(accountReset).mockResolvedValue({ ok: true });
    const navigate = vi.fn();
    render(<Account mode="reset" navigate={navigate} />);
    expect(screen.getByRole("heading", { name: copy("account.reset.title") })).toBeInTheDocument();
    expect(screen.queryByLabelText(copy("account.password.field"))).toBeNull();
    await user.type(screen.getByLabelText(copy("account.email.field")), EMAIL);
    await user.click(screen.getByRole("button", { name: continueLabel }));
    expect(accountRequestReset).toHaveBeenCalledWith(EMAIL);
    expect(await screen.findByRole("heading", { name: copy("account.reset.code") })).toBeInTheDocument();
    expect(screen.getByTestId("fake-code")).toHaveTextContent("999000");
    const submit = screen.getByRole("button", { name: copy("account.reset.button") });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(copy("auth.code.enter", { destination: EMAIL })), "999000");
    const pw = screen.getByLabelText(copy("account.password.field"));
    expect(pw).toHaveAttribute("autocomplete", "new-password");
    await user.type(pw, "new horse battery");
    await user.click(submit);
    expect(accountReset).toHaveBeenCalledWith("ch-r", "999000", "new horse battery");
    const done = await screen.findByTestId("account-done");
    expect(done).toHaveTextContent(copy("account.reset.done"));
    expect(within(done).getByRole("link", { name: copy("account.signin.button") })).toHaveAttribute("href", "/sign-in");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a wrong reset code renders the API's copy key and the form stays", async () => {
    vi.mocked(accountRequestReset).mockResolvedValue({ ok: true });
    vi.mocked(accountReset).mockRejectedValue(apiError(401, "OTP_INVALID", "auth.code_wrong"));
    render(<Account mode="reset" />);
    await user.type(screen.getByLabelText(copy("account.email.field")), EMAIL);
    await user.click(screen.getByRole("button", { name: continueLabel }));
    await user.type(await screen.findByLabelText(copy("auth.code.enter", { destination: EMAIL })), "000000");
    await user.type(screen.getByLabelText(copy("account.password.field")), "new horse battery");
    await user.click(screen.getByRole("button", { name: copy("account.reset.button") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("auth.code_wrong"));
    expect(accountReset).toHaveBeenCalledWith("", "000000", "new horse battery"); // no challenge named (an unknown e-mail still answers ok)
    expect(screen.getByTestId("account-reset")).toBeInTheDocument();
  });
});
