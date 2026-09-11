/** Build-time flags. NEXT_PUBLIC_* values are inlined by Next at build. */
export const FIXTURES_MODE = process.env.NEXT_PUBLIC_FIXTURES === "1";
export const DEV_MODE = process.env.NODE_ENV !== "production";
/**
 * Every vendor stub (Stripe Identity, Plaid, Truv, IRS IVES, carrier connection,
 * RON platform) renders a visible "FAKE vendor" marker whenever this is true.
 * The API itself runs INTEGRATIONS=fake in nonprod (infra/terraform/run.tf), so the
 * marker also shows in dev builds pointed at nonprod.
 */
export const SHOW_FAKE_MARKERS = FIXTURES_MODE || DEV_MODE;
export const THEME_DEFAULT: "dark" | "light" = "dark";
