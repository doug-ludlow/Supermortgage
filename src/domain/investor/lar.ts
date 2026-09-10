/**
 * LAR codec (5.1 rules 3, 5, 6, 8) on the Investor Reporting Manual record
 * layouts the spec transcribes position by position (IRM Apr. 8, 2026 pp.
 * 12–14, 28–32; every record 80 characters + CR):
 *
 *   LAR 96  1–9 lender (servicer) number · 10 investor `F` · 11–12 `96` · 13 source
 *           code, always `0` · 14–23 Fannie Mae loan number · 24–27 LPI MMYY ·
 *           28–38 UPB S9(9)V99 · 39–49 interest · 50–60 principal · 61–62 action
 *           code · 63–68 action date MMDDYY · 69–76 other fees S9(6)V99 · 77–80 filler
 *   LAR 97  1–12 as above with `97` · 13 reversal flag (0 normal, 1 reversal) ·
 *           14–23 loan number · 24–34 gross actual payment 9(9)V99 · 35–42 payment
 *           effective date MMDDYYYY · 43–72 filler · 73–80 full LPI date MMDDYYYY
 *
 * Zone-sign overpunch on the last digit: `{`/`}` = ±0, `A–I` = +1..+9, `J–R` =
 * −1..−9 ($50,000.01 → `0000500000A`; −$9.91 → `0000000099J`). NOTE: the spec's
 * 5.1-T1 strings carry one extra zero and are treated as a transcription slip
 * (docs/audit/AUDIT-REPORT.md); 5.1-T8 and the IRM examples follow this rule.
 * `validateLar80` is the codec the contract tests run fixture files through
 * (positions, zone signs, record length).
 */
import { createHash } from "node:crypto";
import type { Cents } from "../../kernel/money/cents.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { LarPayload } from "./types.ts";

const POS = "{ABCDEFGHI", NEG = "}JKLMNOPQR";
export function zoned(cents: Cents, width = 11): string {
  const neg = cents < 0n; const abs = (neg ? -cents : cents).toString().padStart(width, "0");
  if (abs.length > width) throw new RangeError(`amount ${cents} exceeds ${width} digits`);
  const last = Number(abs[abs.length - 1]);
  return abs.slice(0, -1) + (neg ? NEG : POS)[last];
}
export function unzoned(s: string): Cents {
  const c = s[s.length - 1]!; const body = s.slice(0, -1);
  const pi = POS.indexOf(c), ni = NEG.indexOf(c);
  if (pi < 0 && ni < 0) throw new RangeError(`bad overpunch ${c}`);
  const v = BigInt(body + String(pi >= 0 ? pi : ni));
  return ni >= 0 ? -v : v;
}
export const mmyy = (d: PlainDate | null): string => (d ? d.slice(5, 7) + d.slice(2, 4) : "0000");
export const mmddyy = (d: PlainDate): string => d.slice(5, 7) + d.slice(8, 10) + d.slice(2, 4);
export const mmddyyyy = (d: PlainDate | null): string => (d ? d.slice(5, 7) + d.slice(8, 10) + d.slice(0, 4) : "00000000");

/** 1-based inclusive positions of the LAR 96 layout (IRM p. 12). */
export const LAR96_POSITIONS = {
  servicer_number: [1, 9], investor: [10, 10], record_type: [11, 12], source_code: [13, 13], fnma_loan_number: [14, 23], lpi: [24, 27],
  upb: [28, 38], interest: [39, 49], principal: [50, 60], action_code: [61, 62], action_date: [63, 68], other_fees: [69, 76], filler: [77, 80],
} as const;
/** 1-based inclusive positions of the LAR 97 layout (IRM p. 14). */
export const LAR97_POSITIONS = {
  servicer_number: [1, 9], investor: [10, 10], record_type: [11, 12], reversal_flag: [13, 13], fnma_loan_number: [14, 23], gross_payment: [24, 34], effective_date: [35, 42], filler: [43, 72], lpi: [73, 80],
} as const;
export const LAR_RECORD_LENGTH = 80;
export const LAR_RECORD_TYPES = ["96", "97", "81", "83", "89", "32"] as const;
const at = (rec: string, [from, to]: readonly [number, number]): string => rec.slice(from - 1, to);

export interface Lar96Fields { readonly servicer_number: string; readonly investor: "F"; readonly record_type: "96"; readonly source_code: "0"; readonly fnma_loan_number: string; readonly lpi: string; readonly upb: string; readonly interest: string; readonly principal: string; readonly action_code: string; readonly action_date: string; readonly other_fees: string }
export interface Lar96 { readonly record: string; readonly fields: Lar96Fields }

/** LAR 96 projection (5.1 rule 3): the 80-character IRM record plus CR. */
export function projectLar96(servicerNumber: string, fnmaLoanNumber: string, p: LarPayload): Lar96 {
  const f: Lar96Fields = {
    servicer_number: servicerNumber.padStart(9, "0").slice(-9), investor: "F", record_type: "96", source_code: "0", fnma_loan_number: fnmaLoanNumber.padStart(10, "0").slice(-10), lpi: mmyy(p.lpi_date),
    upb: zoned(p.upb_cents), interest: zoned(p.interest_cents), principal: zoned(p.principal_cents), action_code: p.action_code.padStart(2, "0"), action_date: mmddyy(p.action_date), other_fees: zoned(p.other_fees_cents, 8),
  };
  const record = f.servicer_number + f.investor + f.record_type + f.source_code + f.fnma_loan_number + f.lpi + f.upb + f.interest + f.principal + f.action_code + f.action_date + f.other_fees + "    ";
  if (record.length !== LAR_RECORD_LENGTH) throw new Error(`LAR 96 record length ${record.length} ≠ 80`);
  return { record: record + "\r", fields: f };
}

/** LAR 97 companion for detailed-reporting loans (5.1 rule 5): gross payment, payment effective date MMDDYYYY, full LPI; reversals set pos 13 = 1. */
export function projectLar97(servicerNumber: string, fnmaLoanNumber: string, grossPaymentCents: Cents, effective: PlainDate, lpi: PlainDate | null, reversal: boolean): string {
  if (grossPaymentCents < 0n) throw new RangeError("LAR 97 gross payment is unsigned 9(9)V99; reversals set pos 13 = 1");
  const gross = grossPaymentCents.toString().padStart(11, "0");
  if (gross.length > 11) throw new RangeError(`gross payment ${grossPaymentCents} exceeds 9(9)V99`);
  const rec = servicerNumber.padStart(9, "0").slice(-9) + "F" + "97" + (reversal ? "1" : "0") + fnmaLoanNumber.padStart(10, "0").slice(-10) + gross + mmddyyyy(effective) + " ".repeat(30) + mmddyyyy(lpi);
  if (rec.length !== LAR_RECORD_LENGTH) throw new Error(`LAR 97 record length ${rec.length} ≠ 80`);
  return rec + "\r";
}

/** Decode a LAR 96 record back into its fields (the codec's read side). */
export function parseLar96(record: string): Lar96Fields & { upb_cents: Cents; interest_cents: Cents; principal_cents: Cents; other_fees_cents: Cents } {
  const errs = validateLar80(record); if (errs.length) throw new RangeError(errs.join("; "));
  const r = record.replace(/\r$/, "");
  const P = LAR96_POSITIONS;
  return { servicer_number: at(r, P.servicer_number), investor: "F", record_type: "96", source_code: "0", fnma_loan_number: at(r, P.fnma_loan_number), lpi: at(r, P.lpi), upb: at(r, P.upb), interest: at(r, P.interest), principal: at(r, P.principal), action_code: at(r, P.action_code), action_date: at(r, P.action_date), other_fees: at(r, P.other_fees),
    upb_cents: unzoned(at(r, P.upb)), interest_cents: unzoned(at(r, P.interest)), principal_cents: unzoned(at(r, P.principal)), other_fees_cents: unzoned(at(r, P.other_fees)) };
}

const ZONED = /^[0-9]*[{}A-R]$/;
/** Contract-test codec (5.1 integrations): record length, investor `F`, record type, source/reversal flag, zone signs and numeric dates at their IRM positions. */
export function validateLar80(recordWithOptionalCr: string): string[] {
  const errs: string[] = [];
  const r = recordWithOptionalCr.replace(/\r$/, "");
  if (r.length !== LAR_RECORD_LENGTH) errs.push(`record is ${r.length} characters, not 80`);
  if (r.length < 23) return errs;
  if (!/^[0-9]{9}$/.test(at(r, LAR96_POSITIONS.servicer_number))) errs.push("pos 1–9 servicer number must be 9 digits");
  if (at(r, LAR96_POSITIONS.investor) !== "F") errs.push("pos 10 investor must be F");
  const type = at(r, LAR96_POSITIONS.record_type);
  if (!(LAR_RECORD_TYPES as readonly string[]).includes(type)) errs.push("record type must be 96/97/81/83/89/32");
  if (!/^[0-9]{10}$/.test(at(r, LAR96_POSITIONS.fnma_loan_number))) errs.push("pos 14–23 Fannie Mae loan number must be 10 digits");
  if (r.length !== LAR_RECORD_LENGTH) return errs;
  if (type === "96") {
    const P = LAR96_POSITIONS;
    if (at(r, P.source_code) !== "0") errs.push("pos 13 source code is always 0");
    if (!/^[0-9]{4}$/.test(at(r, P.lpi))) errs.push("pos 24–27 LPI must be MMYY");
    if (!ZONED.test(at(r, P.upb)) || at(r, P.upb).length !== 11) errs.push("pos 28–38 UPB is not zone-signed S9(9)V99");
    if (!ZONED.test(at(r, P.interest))) errs.push("pos 39–49 interest is not zone-signed S9(9)V99");
    if (!ZONED.test(at(r, P.principal))) errs.push("pos 50–60 principal is not zone-signed S9(9)V99");
    if (!/^[0-9]{2}$/.test(at(r, P.action_code))) errs.push("pos 61–62 action code must be 2 digits");
    if (!/^[0-9]{6}$/.test(at(r, P.action_date))) errs.push("pos 63–68 action date must be MMDDYY");
    if (!ZONED.test(at(r, P.other_fees))) errs.push("pos 69–76 other fees is not zone-signed S9(6)V99");
    if (at(r, P.filler).trim() !== "") errs.push("pos 77–80 filler must be blank");
  } else if (type === "97") {
    const P = LAR97_POSITIONS;
    if (!/^[01]$/.test(at(r, P.reversal_flag))) errs.push("pos 13 reversal flag must be 0 or 1");
    if (!/^[0-9]{11}$/.test(at(r, P.gross_payment))) errs.push("pos 24–34 gross payment must be 9(9)V99");
    if (!/^[0-9]{8}$/.test(at(r, P.effective_date))) errs.push("pos 35–42 payment effective date must be MMDDYYYY");
    if (!/^[0-9]{8}$/.test(at(r, P.lpi))) errs.push("pos 73–80 LPI must be MMDDYYYY");
  }
  return errs;
}

/** 5.1 rule 8 idempotency key. */
export function idempotencyKey(servicer: string, fnmaLoan: string, type: string, effective: PlainDate, seq: number, payload: LarPayload): string {
  const ph = createHash("sha256").update(JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).digest("hex");
  return createHash("sha256").update([servicer, fnmaLoan, type, effective, seq, ph].join("|")).digest("hex");
}

export const REMOVAL_ACTION_CODES: readonly string[] = ["60", "65", "67", "70", "71", "72"];
export interface ExpectedPosition { readonly upb_cents: Cents; readonly lpi_date: PlainDate | null; /** Fannie Mae's non-interest-bearing (forbearance) balance; when present the NIB fatal rules apply. */ readonly nib_cents?: Cents; readonly participation_pct?: string }
const partOf = (c: Cents, pct: string | undefined): Cents => { if (!pct || pct === "100") return c; const scaled = c * BigInt(Math.round(Number(pct) * 1_000_000)); const den = 100n * 1_000_000n; const q = scaled / den; const rem = scaled - q * den; return rem * 2n >= den ? q + 1n : q; };
/**
 * Local pre-validation of every published fatal rule (5.1 rule 6 / Reference Guide v1.0): UPB within ±$0.05 of Fannie Mae's
 * projection; effective date ≤ today and ≥ last accepted; LPI exactly one period forward; NIB balance aligned; and (IRM 4-01/4-02,
 * 5.3-T5) a removal's reported principal must include the non-interest-bearing forbearance balance or the LAR hard-rejects.
 */
export function prevalidate(p: LarPayload, expected: ExpectedPosition, today: PlainDate, lastAcceptedEffective: PlainDate | null): string[] {
  const errs: string[] = [];
  const diff = p.upb_cents - expected.upb_cents;
  const isRemoval = REMOVAL_ACTION_CODES.includes(p.action_code);
  if (!isRemoval && (diff > 5n || diff < -5n)) errs.push(`UPB ${p.upb_cents} outside ±5¢ of projection ${expected.upb_cents}`);
  if (p.action_date > today) errs.push("effective date in the future");
  if (lastAcceptedEffective && p.action_date < lastAcceptedEffective) errs.push("effective date before last accepted");
  if (p.action_code === "00" && expected.lpi_date && p.lpi_date && p.interest_cents > 0n) {
    const [ey, em] = [Number(expected.lpi_date.slice(0, 4)), Number(expected.lpi_date.slice(5, 7))];
    const [py, pm] = [Number(p.lpi_date.slice(0, 4)), Number(p.lpi_date.slice(5, 7))];
    const months = (py - ey) * 12 + (pm - em);
    if (months < 1) errs.push(`LPI ${p.lpi_date} must advance from ${expected.lpi_date}`);
  }
  if (expected.nib_cents !== undefined) {
    if (p.nib_cents !== expected.nib_cents) errs.push(`NIB balance ${p.nib_cents} not aligned with Fannie Mae's ${expected.nib_cents}`);
    if (isRemoval && expected.nib_cents > 0n) {
      const required = partOf(expected.upb_cents + expected.nib_cents, expected.participation_pct);
      const d = p.principal_cents - required;
      if (d > 5n || d < -5n) errs.push(`removal principal ${p.principal_cents} omits the non-interest-bearing balance: expected (UPB ${expected.upb_cents} + NIB ${expected.nib_cents}) × participation = ${required} (IRM 4-02 hard reject)`);
    }
  }
  return errs;
}
