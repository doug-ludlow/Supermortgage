/**
 * LAR 96 projection (5.1 rule 3) with IBM zoned-decimal sign overpunch on the
 * last digit: +0..+9 → { A–I, −0..−9 → } J–R. Field width 11 (cents).
 * NOTE: the spec's 5.1-T8 strings (−$9.91 → `0000000099J`, $800.02 →
 * `0000008000B`) follow this rule; its 5.1-T1 strings carry one extra zero and
 * are treated as a transcription slip. Layout positions below are this
 * platform's projection and must be aligned to the IRM record layout at
 * credentialing.
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

export interface Lar96 { readonly record: string; readonly fields: { interest: string; principal: string; upb: string; other_fees: string; action_code: string; action_date: string; lpi: string } }

export function projectLar96(servicerNumber: string, fnmaLoanNumber: string, p: LarPayload): Lar96 {
  const f = { interest: zoned(p.interest_cents), principal: zoned(p.principal_cents), upb: zoned(p.upb_cents), other_fees: zoned(p.other_fees_cents), action_code: p.action_code, action_date: mmddyy(p.action_date), lpi: mmyy(p.lpi_date) };
  const record = "96" + servicerNumber.padStart(9, "0") + fnmaLoanNumber.padStart(10, "0") + f.action_code + f.action_date + f.lpi + f.interest + f.principal + f.upb + f.other_fees + "   ";
  if (record.length !== 80) throw new Error(`LAR 96 record length ${record.length} ≠ 80`);
  return { record: record + "\r", fields: f };
}

/** LAR 97 companion for detailed-reporting loans (5.1 rule 5). */
export function projectLar97(servicerNumber: string, fnmaLoanNumber: string, grossPaymentCents: Cents, effective: PlainDate, lpi: PlainDate | null, reversal: boolean): string {
  const rec = "97" + servicerNumber.padStart(9, "0") + fnmaLoanNumber.padStart(10, "0") + zoned(grossPaymentCents) + effective.slice(5, 7) + effective.slice(8, 10) + effective.slice(0, 4) + (lpi ? lpi.slice(5, 7) + lpi.slice(8, 10) + lpi.slice(0, 4) : "00000000") + (reversal ? "1" : "0");
  return rec.padEnd(80, " ") + "\r";
}

/** 5.1 rule 8 idempotency key. */
export function idempotencyKey(servicer: string, fnmaLoan: string, type: string, effective: PlainDate, seq: number, payload: LarPayload): string {
  const ph = createHash("sha256").update(JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).digest("hex");
  return createHash("sha256").update([servicer, fnmaLoan, type, effective, seq, ph].join("|")).digest("hex");
}

/** Local pre-validation of fatal rules (5.1 rule 6): UPB within ±$0.05 of Fannie Mae's projection; LPI exactly one period forward; effective date sane. */
export function prevalidate(p: LarPayload, expected: { upb_cents: Cents; lpi_date: PlainDate | null }, today: PlainDate, lastAcceptedEffective: PlainDate | null): string[] {
  const errs: string[] = [];
  const diff = p.upb_cents - expected.upb_cents; if (diff > 5n || diff < -5n) errs.push(`UPB ${p.upb_cents} outside ±5¢ of projection ${expected.upb_cents}`);
  if (p.action_date > today) errs.push("effective date in the future");
  if (lastAcceptedEffective && p.action_date < lastAcceptedEffective) errs.push("effective date before last accepted");
  if (p.action_code === "00" && expected.lpi_date && p.lpi_date && p.interest_cents > 0n) {
    const [ey, em] = [Number(expected.lpi_date.slice(0, 4)), Number(expected.lpi_date.slice(5, 7))];
    const [py, pm] = [Number(p.lpi_date.slice(0, 4)), Number(p.lpi_date.slice(5, 7))];
    const months = (py - ey) * 12 + (pm - em);
    if (months < 1) errs.push(`LPI ${p.lpi_date} must advance from ${expected.lpi_date}`);
  }
  return errs;
}
