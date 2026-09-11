/**
 * 32.6 — Decision, property, title, insurance, MI, clear to close: the flow-specific UI. The shell renders whatever
 * cards the API creates (src/runtime/borrower/flows/6-decision-property.ts); these helpers carry the two things a
 * plain card cannot: tokens the server names as copy KEYS (the failing insurance element and its fix; an MI plan's
 * title and its HPA cancellation line) resolved through the copy library, so no sentence is hard-coded on either side.
 */
import { copy, copyOrUndefined, type Tokens } from "@/lib/copy";

/** `copy_token_keys: { element: "insurance.deficient.element.deductible" }` → `{ element: "the deductible" }`, merged over any literal `copy_tokens`. */
export function resolveCopyTokens(props: { copy_tokens?: Record<string, string | string[]>; copy_token_keys?: Record<string, string> }): Tokens | undefined {   // 32.8: a token used twice may be an array
  const keys = props.copy_token_keys;
  if (!keys && !props.copy_tokens) return undefined;
  const out: Record<string, string | string[]> = { ...(props.copy_tokens ?? {}) };
  for (const [name, key] of Object.entries(keys ?? {})) out[name] = copyOrUndefined(key) ?? out[name] ?? key;
  return out;
}

/** A ComparisonCard column titled by a copy key (`title_key`) when the server left `title` empty. */
export function columnTitle(c: { title: string; title_key?: string }): string {
  return c.title || (c.title_key ? copy(c.title_key) : "");
}

/** A ComparisonCard row whose value is a copy key (`value_key`) — the MI plan's cancellation rule, one line each (32.6 §6). */
export function rowValue(r: { value: string; value_key?: string }): string {
  return r.value || (r.value_key ? copy(r.value_key) : "");
}

/** 01 §4 row 9: the Property section's label for a state, when the API sent none. */
export function propertyStateLabel(section: "valuation" | "flood" | "hazard" | "project_review", status: string): string {
  const LABELS: Record<string, Record<string, string>> = {
    valuation: { no_appraisal_needed: "No appraisal needed", copy_delivered: "Appraised value on file", received: "Appraisal received — under review", inspection_scheduled: "Appraisal visit scheduled", assigned: "Appraisal ordered — appraiser assigned", ordered: "Appraisal ordered" },
    flood: { not_in_flood_zone: "Not in a flood zone", in_flood_zone: "In a flood zone — notice on its way", notice_delivered: "In a flood zone — notice delivered" },
    hazard: { verified: "Insurance verified", deficient: "Insurance — one thing to fix", pending: "Insurance not yet received" },
    project_review: { pending_docs: "Waiting on HOA documents", certified: "Project approved", ineligible: "Project doesn't meet the program's requirements" },
  };
  return LABELS[section]?.[status] ?? status;
}
