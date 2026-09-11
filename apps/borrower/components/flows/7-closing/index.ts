/**
 * 32.7 — CD, closing, rescission, funding, boarding: the flow-specific UI. The shell renders whatever cards the API
 * creates (src/runtime/borrower/flows/7-closing.ts); these pieces carry what a plain card cannot: the LE→CD What-changed
 * title, the closing-type choice inside the ScheduleCard (RON only when 26.2 allows it), the H-8/H-9 card's quiet
 * "How to cancel" link, the autodraft authorization's elements, and StatusCard/HandoffCard lines named by copy key.
 */
import { copy, copyOrUndefined, type Tokens } from "@/lib/copy";

export { HowToCancel } from "./HowToCancel";
export { ClosingTypeOptions, defaultClosingType, slotsForType } from "./ClosingTypeOptions";
export { ConsentElements } from "./ConsentElements";

/** A StatusCard's detail lines: the literal `detail`, then `detail_copy_key`, then each of `detail_copy_keys` (32.7 §3 package list, §5 `funded.no_skip`). */
export function statusDetailLines(p: { detail?: string; detail_copy_key?: string; detail_copy_keys?: string[]; copy_tokens?: Record<string, string | string[]> }): string[] {   // 32.8: a token used twice may be an array
  const tokens: Tokens | undefined = p.copy_tokens;
  const out: string[] = [];
  if (p.detail) out.push(p.detail);
  const one = copyOrUndefined(p.detail_copy_key, tokens);
  if (one) out.push(one);
  for (const k of p.detail_copy_keys ?? []) out.push(copy(k, tokens));
  return out;
}

/** A HandoffCard line: the literal when the server sent one, else its copy key (32.7 §2 pre-sign, §6 the Fannie Mae letter). */
export function handoffLine(literal: string | undefined, copyKey: string | undefined, tokens?: Record<string, string>): string {
  return literal || copyOrUndefined(copyKey, tokens) || "";
}
