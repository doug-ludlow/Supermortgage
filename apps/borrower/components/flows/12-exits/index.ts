/**
 * 32.12 — Exits: the flow-specific UI. The shell renders whatever cards the API creates (src/runtime/borrower/flows/12-exits.ts);
 * these helpers carry what a plain card cannot: the read-only banner under a closed or transferred-out Record, the autopay
 * end / termination lines on the Loan section, and the badge tones of the exit states.
 */
export { ExitBanner, EXIT_BADGES, READ_ONLY_EXIT_BADGES } from "./ExitBanner";
import { copy } from "@/lib/copy";
import { formatDate } from "@/lib/format";

/** The Loan section's autopay row when the enrollment is ending (a transfer out) or ended (a payoff / transfer): the copy key with the stored date, never a computed one. */
export function autopayExitLine(autodraft: { status: string; ends_on?: string; terminated_on?: string }): string | null {
  if (autodraft.status === "terminated") return copy("autopay.terminated", { date: autodraft.terminated_on ? formatDate(`${autodraft.terminated_on}T12:00:00Z`, "UTC") : "" });
  if (autodraft.ends_on) return copy("autopay.ends", { date: formatDate(`${autodraft.ends_on}T12:00:00Z`, "UTC") });
  return null;
}
