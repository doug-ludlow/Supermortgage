/**
 * 32.4 — Disclosures, intent to proceed, lock, revised LEs: the flow-specific UI. The shell renders whatever cards the
 * API creates (src/runtime/borrower/flows/4-disclosures.ts); these components carry the two things a plain card cannot:
 * the What-changed diff on a revised LE and the one-message grouping of the LE with its companion disclosures.
 */
export { WhatChanged, rowLabel, rowValue } from "./WhatChanged";
export { DisclosurePackage, packageMembers, type PackageRole } from "./DisclosurePackage";
