/**
 * BAI2 (Cash Management Balance Reporting) parser — enough of the standard to
 * ingest lockbox detail and custodial prior-day/intraday statements (2.1
 * `lockbox`, 6.3/6.4 `custodial-bank`). Records: 01 file header, 02 group
 * header, 03 account identifier (summary type codes), 16 transaction detail,
 * 88 continuation, 49/98/99 account/group/file trailers. Amounts carry no
 * decimal point (implied cents) and are parsed as bigint cents; control totals
 * are verified so a truncated or altered file is refused (spec: "file-level
 * control totals must tie to the deposit").
 */
import type { Cents } from "../../../kernel/money/cents.ts";

export interface Bai2Transaction { readonly typeCode: string; readonly amountCents: Cents; readonly fundsType: string; readonly bankReference: string; readonly customerReference: string; readonly text: string; }
export interface Bai2Summary { readonly typeCode: string; readonly amountCents: Cents | null; readonly itemCount: number | null; readonly fundsType: string; }
export interface Bai2Account { readonly accountNumber: string; readonly currency: string; readonly summaries: readonly Bai2Summary[]; readonly transactions: readonly Bai2Transaction[]; readonly controlTotalCents: Cents; readonly recordCount: number; }
export interface Bai2Group { readonly receiverId: string; readonly originatorId: string; readonly asOfDate: string; readonly asOfTime: string; readonly currency: string; readonly accounts: readonly Bai2Account[]; readonly controlTotalCents: Cents; }
export interface Bai2File { readonly senderId: string; readonly receiverId: string; readonly fileDate: string; readonly fileTime: string; readonly fileId: string; readonly groups: readonly Bai2Group[]; readonly controlTotalCents: Cents; readonly recordCount: number; }

export class Bai2Error extends Error { constructor(m: string) { super(m); this.name = "Bai2Error"; } }

/** Type codes 100–399 are credits, 400–699 debits (BAI2 convention); 010–099 are balances. */
export const isCredit = (typeCode: string): boolean => { const n = Number(typeCode); return n >= 100 && n <= 399; };
export const isDebit = (typeCode: string): boolean => { const n = Number(typeCode); return n >= 400 && n <= 699; };
const yymmdd = (s: string): string => `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;

/** Join 88 continuation records onto their parent; `lines` keeps the physical record count the trailers tally. */
function joinContinuations(lines: readonly string[]): { fields: string[]; lines: number }[] {
  const out: { fields: string[]; lines: number }[] = [];
  for (const raw of lines) {
    const line = raw.trim(); if (!line) continue;
    const fields = line.replace(/\/$/, "").split(",");
    if (fields[0] === "88") { const prev = out[out.length - 1]; if (!prev) throw new Bai2Error("continuation record 88 without a preceding record"); prev.fields.push(...fields.slice(1)); prev.lines++; }
    else out.push({ fields, lines: 1 });
  }
  return out;
}
const cents = (s: string | undefined): Cents | null => (s === undefined || s === "" ? null : BigInt(s.replace(/^\+/, "")));

export function parseBai2(text: string): Bai2File {
  const recs = joinContinuations(text.split(/\r?\n/));
  let file: { senderId: string; receiverId: string; fileDate: string; fileTime: string; fileId: string } | null = null;
  const groups: Bai2Group[] = [];
  let group: { receiverId: string; originatorId: string; asOfDate: string; asOfTime: string; currency: string; accounts: Bai2Account[] } | null = null;
  let acct: { accountNumber: string; currency: string; summaries: Bai2Summary[]; transactions: Bai2Transaction[]; records: number } | null = null;
  let fileRecords = 0, fileTotal: Cents | null = null, fileRecordCount = 0;
  let groupTotal: Cents | null = null;
  const groupTotals: Cents[] = [];
  for (const { fields: f, lines: physical } of recs) {
    fileRecords += physical;
    switch (f[0]) {
      case "01": file = { senderId: f[1] ?? "", receiverId: f[2] ?? "", fileDate: yymmdd(f[3] ?? ""), fileTime: f[4] ?? "", fileId: f[5] ?? "" }; break;
      case "02": group = { receiverId: f[1] ?? "", originatorId: f[2] ?? "", asOfDate: yymmdd(f[4] ?? ""), asOfTime: f[5] ?? "", currency: f[6] || "USD", accounts: [] }; break;
      case "03": {
        if (!group) throw new Bai2Error("03 record outside a group");
        acct = { accountNumber: f[1] ?? "", currency: f[2] || group.currency, summaries: [], transactions: [], records: physical };
        for (let i = 3; i + 3 < f.length + 1 && f[i] !== undefined; i += 4) {
          if (f[i] === "") continue;
          acct.summaries.push({ typeCode: f[i]!, amountCents: cents(f[i + 1]), itemCount: f[i + 2] ? Number(f[i + 2]) : null, fundsType: f[i + 3] ?? "" });
        }
        break;
      }
      case "16": {
        if (!acct) throw new Bai2Error("16 record outside an account");
        acct.records += physical;
        acct.transactions.push({ typeCode: f[1] ?? "", amountCents: cents(f[2]) ?? 0n, fundsType: f[3] ?? "", bankReference: f[4] ?? "", customerReference: f[5] ?? "", text: f.slice(6).join(",").trim() });
        break;
      }
      case "49": {
        if (!acct || !group) throw new Bai2Error("49 record outside an account");
        acct.records += physical;
        const total = cents(f[1]) ?? 0n, count = Number(f[2]);
        const computed = acct.summaries.reduce((s, x) => s + (x.amountCents ?? 0n), 0n) + acct.transactions.reduce((s, t) => s + t.amountCents, 0n);
        if (computed !== total) throw new Bai2Error(`account ${acct.accountNumber} control total ${total} ≠ computed ${computed}`);
        if (count !== acct.records) throw new Bai2Error(`account ${acct.accountNumber} record count ${count} ≠ ${acct.records}`);
        group.accounts.push({ accountNumber: acct.accountNumber, currency: acct.currency, summaries: acct.summaries, transactions: acct.transactions, controlTotalCents: total, recordCount: count });
        acct = null; break;
      }
      case "98": {
        if (!group) throw new Bai2Error("98 record outside a group");
        groupTotal = cents(f[1]) ?? 0n;
        const computed = group.accounts.reduce((s, a) => s + a.controlTotalCents, 0n);
        if (computed !== groupTotal) throw new Bai2Error(`group control total ${groupTotal} ≠ computed ${computed}`);
        groups.push({ ...group, controlTotalCents: groupTotal }); groupTotals.push(groupTotal); group = null; break;
      }
      case "99": {
        fileTotal = cents(f[1]) ?? 0n; fileRecordCount = Number(f[3]);
        const computed = groupTotals.reduce((s, g) => s + g, 0n);
        if (computed !== fileTotal) throw new Bai2Error(`file control total ${fileTotal} ≠ computed ${computed}`);
        if (Number(f[2]) !== groups.length) throw new Bai2Error(`file group count ${f[2]} ≠ ${groups.length}`);
        if (fileRecordCount !== fileRecords) throw new Bai2Error(`file record count ${fileRecordCount} ≠ ${fileRecords}`);
        break;
      }
      default: throw new Bai2Error(`unknown record code ${f[0]}`);
    }
  }
  if (!file) throw new Bai2Error("missing 01 file header");
  if (fileTotal === null) throw new Bai2Error("missing 99 file trailer");
  return { ...file, groups, controlTotalCents: fileTotal, recordCount: fileRecordCount };
}

/** Lockbox detail: every credit transaction is a remittance item; the customer reference carries the scanline (loan number). */
export interface LockboxItem { readonly batchId: string; readonly sequence: number; readonly amountCents: Cents; readonly scanline: string; readonly bankReference: string; readonly depositDate: string; readonly typeCode: string; }
export function lockboxItems(file: Bai2File): LockboxItem[] {
  const items: LockboxItem[] = [];
  for (const g of file.groups) for (const a of g.accounts) {
    let seq = 0;
    for (const t of a.transactions) if (isCredit(t.typeCode)) items.push({ batchId: `${file.fileId}:${a.accountNumber}`, sequence: ++seq, amountCents: t.amountCents, scanline: t.customerReference, bankReference: t.bankReference, depositDate: g.asOfDate, typeCode: t.typeCode });
  }
  return items;
}
