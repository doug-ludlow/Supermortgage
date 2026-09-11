/** Build-time flags. NEXT_PUBLIC_* values are inlined by Next at build. */
export const FIXTURES_MODE = process.env.NEXT_PUBLIC_FIXTURES === "1";
export const DEV_MODE = process.env.NODE_ENV !== "production";
/**
 * The deploy environment the bundle was built for: Dockerfile.borrower's `NEXT_PUBLIC_ENVIRONMENT`
 * build arg, which deploy.yml sets from its `ENVIRONMENT` ("nonprod" by default). Empty for a plain
 * `next build`.
 */
export const BUILD_ENVIRONMENT = process.env.NEXT_PUBLIC_ENVIRONMENT ?? "";
/**
 * A production bundle built for a nonprod environment (the demo). The API there runs
 * INTEGRATIONS=fake (infra/terraform/run.tf), so the FAKE vendor paths — the FAKE Google identity
 * form and its `x-fake-oidc` marker, the echoed OTP code — are the only ones that can work.
 */
export const NONPROD_BUILD = BUILD_ENVIRONMENT !== "" && !/^prod/i.test(BUILD_ENVIRONMENT);
/**
 * Every vendor stub (Stripe Identity, Plaid, Truv, IRS IVES, carrier connection,
 * RON platform, Google sign-in) renders a visible "FAKE vendor" marker whenever this is true.
 * True in fixtures builds, dev builds, and production builds for a nonprod environment;
 * false only in a bundle built for production, where the real vendors are wired.
 */
export const SHOW_FAKE_MARKERS = FIXTURES_MODE || DEV_MODE || NONPROD_BUILD;
export const THEME_DEFAULT: "dark" | "light" = "dark";
