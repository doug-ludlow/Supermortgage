/**
 * 32.9 — Servicing: insurance, PMI, ARM, life events, requests: the flow-specific UI. The shell renders whatever cards
 * the API creates (src/runtime/borrower/flows/9-servicing-requests.ts: the FPI, flood, PMI, case, successor and payoff
 * cards are plain NoticeCards / StatusCards / ChoiceCards / UploadCards keyed by the copy library); the one thing a plain
 * card cannot carry is the ARM estimate on Numbers, rendered here from `numbers.arm_estimate`.
 */
export { ArmEstimateRows } from "./ArmEstimate";
