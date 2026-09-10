/**
 * §9.4 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides; the section's original templates stay in ./section09.ts. Spread by
 * ../catalog.ts after the section files, so a version here supersedes one there for the same code and effective date.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const VERSIONS_9_4: VersionInput[] = [];
// 9.4 outputs: "Notice `INS_FPI_RENEWAL_MS3D` … first-class mail; always mailed" and §1024.37(f) — the mailed copy anchors the
// 45-day gate (`fpi.renewal_notice.sent` is recorded from the print-mail proof of mailing), so the template never goes
// electronic-only even with active E-SIGN consent (an e-delivered notice would never emit `notice.mailed`).
export const OVERRIDES_9_4: Record<string, Partial<NoticeTemplate>> = { INS_FPI_RENEWAL_MS3D: { channelPolicy: "mail_only" } };
