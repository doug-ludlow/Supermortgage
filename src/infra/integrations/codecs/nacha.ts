/**
 * Nacha ACH file codec (2.3 `nacha` adapter): builds a PPD/WEB/TEL debit file
 * from entries and parses return/NOC files (return entries carry an addenda
 * record `7` with the R-code; NOCs carry C-codes). Fixed 94-character records:
 * 1 file header, 5 batch header, 6 entry detail, 7 addenda, 8 batch control,
 * 9 file control, padded to a block of 10 with `9` filler lines.
 */
import type { Cents } from "../../../kernel/money/cents.ts";

export interface AchEntry { readonly transactionCode: "27" | "37" | "28" | "38"; readonly routingNumber: string; readonly accountNumber: string; readonly amountCents: Cents; readonly individualId: string; readonly individualName: string; readonly traceSequence: number; readonly addenda?: string; }
export interface AchBatch { readonly secCode: "PPD" | "WEB" | "TEL" | "CCD"; readonly companyName: string; readonly companyId: string; readonly entryDescription: string; readonly effectiveDate: string; readonly odfiRouting: string; readonly entries: readonly AchEntry[]; }
export interface AchFile { readonly immediateDestination: string; readonly immediateOrigin: string; readonly fileDate: string; readonly fileTime: string; readonly fileIdModifier: string; readonly batches: readonly AchBatch[]; }

const pad = (s: string, n: number, right = false, ch = " "): string => (right ? s.padEnd(n, ch) : s.padStart(n, ch)).slice(0, n);
const num = (n: number | bigint, w: number): string => pad(n.toString(), w, false, "0");
const yymmdd = (iso: string): string => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
export const traceNumber = (odfiRouting: string, seq: number): string => odfiRouting.slice(0, 8) + num(seq, 7);

export function buildNachaFile(f: AchFile): string {
  const lines: string[] = [];
  lines.push(`101${pad(f.immediateDestination, 10)}${pad(f.immediateOrigin, 10)}${yymmdd(f.fileDate)}${f.fileTime.slice(0, 4)}${f.fileIdModifier}094101${pad("", 23, true)}${pad("", 23, true)}${pad("", 8, true)}`);
  let batchNo = 0, entryTotal = 0, hash = 0n, debitTotal = 0n, creditTotal = 0n;
  for (const b of f.batches) {
    batchNo++;
    const isDebit = b.entries.some((e) => e.transactionCode === "27" || e.transactionCode === "28");
    const serviceClass = isDebit && b.entries.every((e) => e.transactionCode === "27" || e.transactionCode === "28") ? "225" : "200";
    lines.push(`5${serviceClass}${pad(b.companyName, 16, true)}${pad("", 20, true)}${pad(b.companyId, 10)}${b.secCode}${pad(b.entryDescription, 10, true)}${pad("", 6, true)}${yymmdd(b.effectiveDate)}   1${b.odfiRouting.slice(0, 8)}${num(batchNo, 7)}`);
    let bHash = 0n, bDebit = 0n, bCredit = 0n, bCount = 0;
    for (const e of b.entries) {
      bCount++;
      const rdfi = e.routingNumber.slice(0, 8), check = e.routingNumber.slice(8, 9);
      lines.push(`6${e.transactionCode}${rdfi}${check}${pad(e.accountNumber, 17, true)}${num(e.amountCents, 10)}${pad(e.individualId, 15, true)}${pad(e.individualName, 22, true)}  ${e.addenda ? "1" : "0"}${traceNumber(b.odfiRouting, e.traceSequence)}`);
      if (e.addenda) { bCount++; lines.push(`705${pad(e.addenda, 80, true)}0001${num(e.traceSequence, 7)}`); }
      bHash += BigInt(rdfi);
      if (e.transactionCode === "27" || e.transactionCode === "28") bDebit += e.amountCents; else bCredit += e.amountCents;
    }
    lines.push(`8${serviceClass}${num(bCount, 6)}${num(bHash % 10_000_000_000n, 10)}${num(bDebit, 12)}${num(bCredit, 12)}${pad(b.companyId, 10)}${pad("", 19, true)}${pad("", 6, true)}${b.odfiRouting.slice(0, 8)}${num(batchNo, 7)}`);
    entryTotal += bCount; hash += bHash; debitTotal += bDebit; creditTotal += bCredit;
  }
  const blocks = Math.ceil((lines.length + 1) / 10);
  lines.push(`9${num(batchNo, 6)}${num(blocks, 6)}${num(entryTotal, 8)}${num(hash % 10_000_000_000n, 10)}${num(debitTotal, 12)}${num(creditTotal, 12)}${pad("", 39, true)}`);
  while (lines.length % 10 !== 0) lines.push("9".repeat(94));
  return lines.join("\n") + "\n";
}

export interface AchReturn { readonly kind: "return" | "noc"; readonly code: string; readonly originalTrace: string; readonly amountCents: Cents; readonly individualId: string; readonly correctedData?: string; readonly returnDate?: string; }

/** Parse a returns/NOC file: each `6` entry followed by a `7` addenda with reason code R.. (return) or C.. (NOC). */
export function parseAchReturns(text: string): AchReturn[] {
  const out: AchReturn[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.length >= 94);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l[0] !== "6") continue;
    const amount = BigInt(l.slice(29, 39)); const individualId = l.slice(39, 54).trim();
    const add = lines[i + 1];
    if (!add || add[0] !== "7") continue;
    const typeCode = add.slice(1, 3);
    const code = add.slice(3, 6);
    const originalTrace = add.slice(6, 21);
    if (typeCode === "99") out.push({ kind: "return", code, originalTrace, amountCents: amount, individualId, returnDate: add.slice(21, 27) });
    else if (typeCode === "98") out.push({ kind: "noc", code, originalTrace, amountCents: amount, individualId, correctedData: add.slice(35, 64).trim() });
  }
  return out;
}

/** Build one return entry pair (used by the fake ODFI to script returns). */
export function returnRecord(e: { transactionCode: string; rdfi: string; account: string; amountCents: Cents; individualId: string; name: string; originalTrace: string; code: string; returnDate: string; correctedData?: string }): string {
  const isNoc = e.code.startsWith("C");
  const entry = `6${isNoc ? (e.transactionCode === "27" ? "21" : "31") : e.transactionCode === "27" ? "21" : "31"}${pad(e.rdfi.slice(0, 8), 8)}${e.rdfi.slice(8, 9) || "0"}${pad(e.account, 17, true)}${num(e.amountCents, 10)}${pad(e.individualId, 15, true)}${pad(e.name, 22, true)}  1${pad(e.originalTrace, 15)}`;
  const addenda = isNoc ? `798${e.code}${pad(e.originalTrace, 15)}${pad("", 6, true)}${pad("", 8, true)}${pad(e.correctedData ?? "", 29, true)}${pad("", 15, true)}${pad(e.originalTrace, 15)}` : `799${e.code}${pad(e.originalTrace, 15)}${yymmdd(e.returnDate)}${pad("", 3, true)}${pad("", 8, true)}${pad("", 44, true)}${pad(e.originalTrace, 15)}`;
  return `${pad(entry, 94, true)}\n${pad(addenda, 94, true)}\n`;
}
