/**
 * §35.2 rule 11 — the Form 1098 Copy B substitute statement (IRS Publication 1179, Rev. 07-2026 — Rev. Proc. 2026-18,
 * §4.1.3 and §4.4.1; Form 1098 (Rev. April 2025) and its Instructions for Payer/Borrower). `documents.render{document_kind =
 * irs_1098_copy_b}` takes 7.1's `tax_forms_1098` boxes (cents) and renders: the tax year, form number (1098) and form name
 * displayed prominently together in one area; the official box numbers and captions; the recipient/lender block with
 * Supermortgage's name, address, telephone number and TIN in full (the filer's TIN is never truncated — §2.2.1 permits
 * truncating the payer's only); the payer block with the payer's TIN truncated to its last four (XXX-XX-1234 — the renderer
 * takes only `tin_last4`, so a full payer TIN cannot reach the page); the direct-access telephone number of an individual who
 * can answer questions about the statement; the two §4.4.1 legends verbatim; the Instructions for Payer/Borrower; money as
 * $1,234.56. The figures are 7.1's, reproduced to the cent and never recomputed (rule 12).
 */
import { money, longDate } from "../../../notices/render.ts";
import { writePdf, sha256Hex, type BlockInput, type Placement } from "../../../infra/files/pdf.ts";
import { canonicalJson, payloadHash } from "../../../notices/render.ts";

export const IRS_1098_TEMPLATE_CODE = "IRS_1098_COPY_B";
export const IRS_1098_TEMPLATE_VERSION = "2025-04";   // Form 1098 (Rev. April 2025); Pub. 1179 (Rev. 07-2026)

/** Pub. 1179 §4.4.1 legend (1), verbatim (35.2 rule 11). */
export const LEGEND_1 = "The information in boxes 1 through 9 and 11 is important tax information and is being furnished to the IRS. If you are required to file a return, a negligence penalty or other sanction may be imposed on you if the IRS determines that an underpayment of tax results because you overstated a deduction for the mortgage interest or for these points, reported in boxes 1 and 6; or because you did not report the refund of interest (box 4); or because you claimed a nondeductible item.";
/** Pub. 1179 §4.4.1 legend (2), verbatim (35.2 rule 11). */
export const LEGEND_2 = "*Caution: The amount shown may not be fully deductible by you. Limits based on the loan amount and the cost and value of the secured property may apply. Also, you may only deduct interest to the extent it was incurred by you, actually paid by you, and not reimbursed by another person.";

/** The filer (recipient/lender) block: Supermortgage's own identity. 35.4 supplies the production values; the EIN here is the FAKE filer's of every nonprod stage. */
export const SM_FILER = { name: "Supermortgage Servicing LLC", address: "PO Box 1, Testville TX 75001", phone: "(800) 555-0100", tin: "12-3456789" } as const;

export const INSTRUCTIONS_FOR_PAYER = [
  "Instructions for Payer/Borrower. A person (including a financial institution, a governmental unit, and a cooperative housing corporation) who is engaged in a trade or business and, in the course of such trade or business, received from you at least $600 of mortgage interest (including certain points) on any one mortgage in the calendar year must furnish this statement to you.",
  "If you received this statement as the payer of record on a mortgage on which there are other borrowers, furnish each of the other borrowers with information about the proper distribution of amounts reported on this form. Each borrower is entitled to deduct only the amount each borrower paid and points paid by the seller that represent each borrower's share of the amount allowable as a deduction. Each borrower may have to include in income a share of any amount reported in box 4.",
  "If your mortgage payments were subsidized by a government agency, you may not be able to deduct the amount of the subsidy. See the instructions for Schedule A, C, or E (Form 1040) for how to report the mortgage interest. Also, for more information, see Pub. 936 and Pub. 535.",
  "Payer's/Borrower's taxpayer identification number (TIN). For your protection, this form may show only the last four digits of your TIN (SSN, ITIN, ATIN, or EIN). However, the issuer has reported your complete TIN to the IRS.",
  "Account number. May show an account or other unique number the lender has assigned to distinguish your account.",
  "Box 1. Shows the mortgage interest received by the recipient/lender during the year. This amount includes interest on any obligation secured by real property, including a mortgage, home equity loan, or line of credit. This amount does not include points, government subsidy payments, or seller payments on a buydown mortgage. Such amounts are deductible by you only in certain circumstances. Caution: If you prepaid interest in the tax year that accrued in full by January 15 of the following year, this prepaid interest may be included in box 1. However, you cannot deduct the prepaid amount in the tax year even though it may be included in box 1. If you hold a mortgage credit certificate and can claim the mortgage interest credit, see Form 8396. If the interest was paid on a mortgage, home equity loan, or line of credit secured by a qualified residence, you can only deduct the interest paid on acquisition indebtedness, and you may be subject to a deduction limitation.",
  "Box 2. Shows the outstanding principal on the mortgage as of January 1 of the tax year. If the mortgage originated in the tax year, shows the mortgage principal as of the date of origination. If the recipient/lender acquired the loan in the tax year, shows the mortgage principal as of the date of acquisition.",
  "Box 3. Shows the date of the mortgage origination.",
  "Box 4. Do not deduct this amount. It is a refund (or credit) for overpayment(s) of interest you made in a prior year or years. If you itemized deductions in the year(s) you paid the interest, you may have to include part or all of the box 4 amount on the Other income line of your tax return. See Pub. 936 to figure the amount to include.",
  "Box 5. If an amount is reported in this box, it may qualify to be treated as deductible mortgage interest. See the tax year's Schedule A (Form 1040) instructions and Pub. 936 to see if you can deduct these amounts.",
  "Box 6. Not all points are reportable to you. Box 6 shows points you or the seller paid this year for the purchase of your principal residence that are required to be reported to you. Generally, these points are fully deductible in the year paid, but you must subtract seller-paid points from the basis of your residence. Other points not reported in box 6 may also be deductible. See Pub. 936 to figure the amount you can deduct.",
  "Box 7. If the address of the property securing the mortgage is the same as the payer's/borrower's, either the box has been checked, or box 8 has been completed.",
  "Box 8. Shows the address or description of the property securing the mortgage.",
  "Box 9. If more than one property secures the loan, shows the number of properties securing the mortgage. If only one property secures the loan, this box may be blank.",
  "Box 10. The interest recipient may use this box to give you other information, such as real estate taxes or insurance paid from escrow.",
  "Box 11. If the recipient/lender acquired the mortgage in the calendar year, shows the date of acquisition.",
  "Future developments. For the latest information about developments related to Form 1098 and its instructions, such as legislation enacted after they were published, go to www.irs.gov/Form1098.",
];

export interface Form1098Boxes {
  readonly box1_cents: bigint; readonly box2_cents: bigint; readonly box3_origination_date: string | null;
  readonly box4_cents?: bigint | null; readonly box5_cents?: bigint | null; readonly box6_cents?: bigint | null;
  readonly box7_same_address?: boolean | null; readonly box8_address?: string | null; readonly box9_count?: number | null; readonly box10_other?: string | null; readonly box11_acquisition_date?: string | null;
}
export interface Copy1098Input {
  readonly tax_year: number;
  readonly boxes: Form1098Boxes;
  readonly filer: { name: string; address: string; phone: string; tin: string };
  readonly payer: { name: string; address: string; tin_last4: string };
  readonly direct_access_phone: string;
  readonly account_last4: string;
  readonly now: string;
}
export interface Copy1098 { readonly bytes: Buffer; readonly sha256: string; readonly byte_size: number; readonly page_count: number; readonly placements: readonly Placement[]; readonly text: string; readonly payload_hash: string; readonly blocks: readonly BlockInput[]; }

/** The payer TIN masked to its last four (Pub. 1179 §2.2.1) — the only form of the payer's TIN the page ever carries. */
export const maskTin = (last4: string): string => { if (!/^\d{4}$/.test(last4)) throw new RangeError("irs_1098_copy_b: payer tin_last4 must be four digits"); return `XXX-XX-${last4}`; };

/** The tax_forms_1098.boxes jsonb (cents as strings) to typed boxes; the figures are 7.1's and are never recomputed. */
export function boxesFromRow(boxes: Record<string, unknown>): Form1098Boxes {
  const cents = (k: string): bigint | null => { const v = boxes[k]; if (v === undefined || v === null || v === "") return null; if (typeof v === "bigint") return v; if (typeof v === "number") return BigInt(Math.round(v)); if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v); throw new RangeError(`irs_1098_copy_b: boxes.${k} is not cents`); };
  const b1 = cents("box1_cents"); const b2 = cents("box2_cents");
  if (b1 === null || b2 === null) throw new RangeError("irs_1098_copy_b: boxes.box1_cents and box2_cents are required");
  const s = (k: string): string | null => (typeof boxes[k] === "string" && boxes[k] ? String(boxes[k]) : null);
  return { box1_cents: b1, box2_cents: b2, box3_origination_date: s("box3_origination_date"), box4_cents: cents("box4_cents"), box5_cents: cents("box5_cents"), box6_cents: cents("box6_cents"),
    box7_same_address: typeof boxes["box7_same_address"] === "boolean" ? (boxes["box7_same_address"] as boolean) : null, box8_address: s("box8_address"), box9_count: typeof boxes["box9_count"] === "number" ? (boxes["box9_count"] as number) : null, box10_other: s("box10_other"), box11_acquisition_date: s("box11_acquisition_date") };
}

export function render1098CopyB(i: Copy1098Input): Copy1098 {
  if (!/^\d{2}-\d{7}$/.test(i.filer.tin)) throw new RangeError("irs_1098_copy_b: the filer's TIN is an EIN in full (never truncated — Pub. 1179 §2.2.1)");
  const b = i.boxes;
  const line = (id: string, y: number, text: string, pt = 10, bold = false): BlockInput => ({ id, page: 1, yFraction: y, pt, bold, text });
  const blocks: BlockInput[] = [
    line("header", 0.0, `${i.tax_year} Form 1098 Mortgage Interest Statement`, 14, true),
    line("copy_b", 0.035, `Copy B — For Payer/Borrower. OMB No. 1545-1380. This is important tax information and is being furnished to the IRS.`),
    line("recipient", 0.08, `RECIPIENT'S/LENDER'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no.: ${i.filer.name}, ${i.filer.address}, ${i.filer.phone}. RECIPIENT'S/LENDER'S TIN: ${i.filer.tin}`),
    line("payer", 0.16, `PAYER'S/BORROWER'S name, street address, city or town, state or province, country, and ZIP or foreign postal code: ${i.payer.name}, ${i.payer.address}. PAYER'S/BORROWER'S TIN: ${maskTin(i.payer.tin_last4)}`),
    line("account", 0.225, `Account number (see instructions): ending ${i.account_last4}`),
    line("box1", 0.26, `Box 1 Mortgage interest received from payer(s)/borrower(s)* ${money(b.box1_cents)}`),
    line("box2", 0.285, `Box 2 Outstanding mortgage principal ${money(b.box2_cents)}`),
    line("box3", 0.31, `Box 3 Mortgage origination date ${b.box3_origination_date ? longDate(b.box3_origination_date) : ""}`),
    line("box4", 0.335, `Box 4 Refund of overpaid interest ${b.box4_cents != null ? money(b.box4_cents) : ""}`),
    line("box5", 0.36, `Box 5 Mortgage insurance premiums ${b.box5_cents != null ? money(b.box5_cents) : ""}`),
    line("box6", 0.385, `Box 6 Points paid on purchase of principal residence ${b.box6_cents != null ? money(b.box6_cents) : ""}`),
    line("box7", 0.41, `Box 7 ${b.box7_same_address ? "[X]" : "[ ]"} If address of property securing mortgage is the same as PAYER'S/BORROWER'S address, the box is checked, or the address or description is entered in box 8.`),
    line("box8", 0.445, `Box 8 Address or description of property securing mortgage ${b.box8_address ?? ""}`),
    line("box9", 0.47, `Box 9 Number of properties securing the mortgage ${b.box9_count != null ? String(b.box9_count) : ""}`),
    line("box10", 0.495, `Box 10 Other ${b.box10_other ?? ""}`),
    line("box11", 0.52, `Box 11 Mortgage acquisition date ${b.box11_acquisition_date ? longDate(b.box11_acquisition_date) : ""}`),
    line("contact", 0.56, `Questions about this statement? Call ${i.direct_access_phone} to reach an individual who can answer them.`),
    line("legend_1", 0.6, LEGEND_1, 9),
    line("legend_2", 0.72, LEGEND_2, 9),
    ...INSTRUCTIONS_FOR_PAYER.map((t, k) => ({ id: `instructions_${k + 1}`, page: 2, yFraction: Math.min(0.02 + k * 0.055, 0.95), pt: 9, bold: false, text: t })),
  ];
  const payload = { tax_year: i.tax_year, boxes: b, filer: i.filer, payer: { name: i.payer.name, address: i.payer.address, tin_last4: i.payer.tin_last4 }, direct_access_phone: i.direct_access_phone, account_last4: i.account_last4 };
  const hash = payloadHash(payload);
  const written = writePdf({ blocks, title: `${IRS_1098_TEMPLATE_CODE} ${i.tax_year}`, idSeed: `${hash}|${IRS_1098_TEMPLATE_VERSION}|en`, creationDate: i.now });
  return { bytes: written.bytes, sha256: sha256Hex(written.bytes), byte_size: written.bytes.length, page_count: written.page_count, placements: written.placements, text: written.text, payload_hash: hash, blocks };
}
export { canonicalJson };
