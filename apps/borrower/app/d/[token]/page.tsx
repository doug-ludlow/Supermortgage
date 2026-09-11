import Link from "next/link";

/**
 * 01 §6.5 deep links: /d/{token} → L1 code (or existing session) → route. Tokens never
 * encode loan data, so this page renders nothing about the loan before L1 (T-X-11).
 * Stub: the OTP step lands with the API seam (POST /v1/borrower/auth/otp, GET /v1/borrower/deeplink/{token}).
 */
export default async function DeepLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main style={{ padding: 24, maxWidth: 560 }}>
      <h1 style={{ fontSize: "1.375rem" }}>One quick check</h1>
      <p>Enter the code we sent you to open this link. Your code keeps this conversation yours.</p>
      <form action="/app/" method="get">
        <input type="hidden" name="d" value={token} />
        <label className="sm-label" htmlFor="otp">
          Code
        </label>
        <input id="otp" name="otp" className="sm-input sm-num" inputMode="numeric" autoComplete="one-time-code" />
        <p>
          <button type="submit" className="sm-btn sm-btn-primary">
            Continue
          </button>
        </p>
      </form>
      <p>
        <Link href="/">Start over</Link>
      </p>
    </main>
  );
}
