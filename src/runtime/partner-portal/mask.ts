/**
 * The partner-grade mask (brief §4.6; 36.1's "Mask tighter than staff"): what a partner surface shows of a homeowner and a
 * loan number. Pure functions; ./routes.ts and ./book.ts call them. The list-row rule: the servicer loan number's last four,
 * the homeowner's first name and last initial, the state — never a raw e-mail or phone, never SSN, TIN or DOB, no investor
 * column, no DTI, FICO never as a filter. The last-four of a servicer loan number is 33.1's own `lastFour`
 * (src/domain/partner-book/import.ts), reused, never a second rule.
 */
export { lastFour } from "../../domain/partner-book/import.ts";

/** The partner-grade name: first name + last initial; never the full name on a partner surface. */
export const firstNameLastInitial = (name: string | null | undefined): string | null => { const parts = (name ?? "").trim().split(/\s+/).filter(Boolean); if (!parts.length) return null; return parts.length === 1 ? parts[0]! : `${parts[0]} ${parts[parts.length - 1]![0]}.`; };
