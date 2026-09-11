/**
 * 32.14 — Entry, sign-up and sign-in: the anonymous minute (S0–S2). The shell renders
 * `<AnonymousMinute renderIdentity={…} />` in place of the Thread when `api.me()` answers 401 on the
 * root route and no `?d=` / `?card=` is present; S3's SignIn plugs into `renderIdentity`.
 */
export { AnonymousMinute, productLabel, splitFirstSentence, type AnonymousMinuteProps } from "./AnonymousMinute";
export { parseMoneyToCents } from "./money";
export { US_STATES, stateName } from "./states";
