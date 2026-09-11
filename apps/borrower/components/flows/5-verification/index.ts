/**
 * 32.5 — Verification, needs list, conditions, second borrower: the flow-specific pieces of the Record. The cards
 * themselves (UploadCard with mismatch / stale / re-request copy, ConfirmCard for a credit-refresh finding,
 * ExplanationCard for a large deposit, ConsentCard{joint_intent}, PersonCard{human_agent}) are the shared card kinds
 * rendering what the API created (src/runtime/borrower/flows/5-verification.ts).
 */
export { WhatWeAreDoing } from "./WhatWeAreDoing";
export { PartyDeliveries } from "./PartyDeliveries";
