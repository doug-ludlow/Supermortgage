/**
 * Bank rails: the lockbox file feed (2.1), custodial-bank statements (6.3/6.4)
 * and the ODFI for ACH origination (2.3). Lockbox idempotency = bank batch id
 * + item sequence; a replayed file is ignored, a re-sent file with changed
 * items raises an exception instead of re-posting; a missing file alarms at
 * 07:00 local and the outage fallback is a bank-portal download by ops.
 */
import { createHash } from "node:crypto";
import { AdapterUnavailable, PermanentRejection } from "./failures.ts";
import { parseBai2, lockboxItems, type Bai2File, type LockboxItem } from "./codecs/bai2.ts";
import { parseAchReturns, type AchReturn } from "./codecs/nacha.ts";

export interface LockboxFile { readonly name: string; readonly content: string; readonly receivedAt: string; }
export interface LockboxIngest { readonly fileHash: string; readonly status: "ingested" | "duplicate" | "changed_items"; readonly items: readonly LockboxItem[]; readonly changed: readonly string[]; readonly file: Bai2File; }
export interface LockboxPort {
  /** Files posted since the last fetch (SFTP/PGP in production). */
  fetch(now: string): Promise<readonly LockboxFile[]>;
}

export class LockboxIngestor {
  private readonly seen = new Map<string, Map<string, string>>();   // batchId → itemKey → item hash
  private readonly files = new Set<string>();
  ingest(content: string): LockboxIngest {
    const fileHash = createHash("sha256").update(content).digest("hex");
    const file = parseBai2(content);
    const items = lockboxItems(file);
    if (this.files.has(fileHash)) return { fileHash, status: "duplicate", items: [], changed: [], file };
    const changed: string[] = [];
    const fresh: LockboxItem[] = [];
    for (const it of items) {
      const key = `${it.batchId}#${it.sequence}`;
      const h = `${it.amountCents}|${it.scanline}|${it.bankReference}`;
      let batch = this.seen.get(it.batchId); if (!batch) { batch = new Map(); this.seen.set(it.batchId, batch); }
      const prev = batch.get(key);
      if (prev === undefined) { batch.set(key, h); fresh.push(it); }
      else if (prev !== h) changed.push(key);
    }
    this.files.add(fileHash);
    if (changed.length) return { fileHash, status: "changed_items", items: fresh, changed, file };
    return { fileHash, status: "ingested", items: fresh, changed: [], file };
  }
}

export class FakeLockbox implements LockboxPort {
  outage = false;
  private queue: LockboxFile[] = [];
  post(name: string, content: string, receivedAt: string): void { this.queue.push({ name, content, receivedAt }); }
  async fetch(_now: string): Promise<readonly LockboxFile[]> {
    if (this.outage) throw new AdapterUnavailable("lockbox", "bank_portal_download");
    const out = this.queue; this.queue = []; return out;
  }
}

/** Missing-file alarm: the daily lockbox file is expected by 07:00 local (2.1). */
export function lockboxFileMissing(lastFileReceivedOn: string | null, today: string, localHHmm: string): boolean {
  return localHHmm >= "07:00" && lastFileReceivedOn !== today;
}

export interface CustodialStatement { readonly accountNumber: string; readonly asOfDate: string; readonly openingLedgerCents: bigint | null; readonly closingLedgerCents: bigint | null; readonly credits: readonly { amountCents: bigint; bankReference: string; text: string; typeCode: string }[]; readonly debits: readonly { amountCents: bigint; bankReference: string; text: string; typeCode: string }[]; readonly interestCreditCents: bigint; }
export interface CustodialBankPort { priorDay(accountNumber: string, asOf: string): Promise<CustodialStatement>; intraday(accountNumber: string, now: string): Promise<CustodialStatement>; }

/** BAI2 → statement: 010 opening ledger, 015 closing ledger; 16 records split by credit/debit; type 165 with "INTEREST" text (or 4xx interest codes) isolated as the interest credit (6.2). */
export function statementFrom(file: Bai2File, accountNumber: string): CustodialStatement {
  for (const g of file.groups) for (const a of g.accounts) if (a.accountNumber === accountNumber) {
    const summary = (code: string) => a.summaries.find((s) => s.typeCode === code)?.amountCents ?? null;
    const credits = a.transactions.filter((t) => Number(t.typeCode) >= 100 && Number(t.typeCode) <= 399).map((t) => ({ amountCents: t.amountCents, bankReference: t.bankReference, text: t.text, typeCode: t.typeCode }));
    const debits = a.transactions.filter((t) => Number(t.typeCode) >= 400 && Number(t.typeCode) <= 699).map((t) => ({ amountCents: t.amountCents, bankReference: t.bankReference, text: t.text, typeCode: t.typeCode }));
    const interestCreditCents = credits.filter((c) => c.typeCode === "155" || /INTEREST/i.test(c.text)).reduce((s, c) => s + c.amountCents, 0n);
    return { accountNumber, asOfDate: g.asOfDate, openingLedgerCents: summary("010"), closingLedgerCents: summary("015"), credits, debits, interestCreditCents };
  }
  throw new PermanentRejection("ACCOUNT_NOT_IN_FILE", `account ${accountNumber} not in BAI2 file ${file.fileId}`);
}

export class FakeCustodialBank implements CustodialBankPort {
  outage = false;
  private readonly files = new Map<string, string>();
  post(accountNumber: string, asOf: string, bai2: string): void { this.files.set(`${accountNumber}@${asOf}`, bai2); }
  async priorDay(accountNumber: string, asOf: string): Promise<CustodialStatement> {
    if (this.outage) throw new AdapterUnavailable("custodial-bank", "bank_portal_download");
    const f = this.files.get(`${accountNumber}@${asOf}`); if (!f) throw new PermanentRejection("NO_STATEMENT", `${accountNumber} ${asOf}`);
    return statementFrom(parseBai2(f), accountNumber);
  }
  async intraday(accountNumber: string, now: string): Promise<CustodialStatement> { return this.priorDay(accountNumber, now.slice(0, 10)); }
}

export interface OdfiAck { readonly fileId: string; readonly status: "accepted" | "rejected"; readonly duplicate: boolean; readonly reason?: string; }
export interface NachaPort {
  transmit(fileName: string, content: string, now: string): Promise<OdfiAck>;
  returns(since: string): Promise<readonly AchReturn[]>;
}
export class FakeOdfi implements NachaPort {
  outage = false;
  readonly files = new Map<string, { fileName: string; at: string }>();
  private returnFiles: { at: string; content: string }[] = [];
  /** Same-Day / next-day windows (bank-specific; policy defaults) in local HH:MM. */
  windows = ["10:30", "14:45", "19:30"];
  postReturns(at: string, content: string): void { this.returnFiles.push({ at, content }); }
  async transmit(fileName: string, content: string, now: string): Promise<OdfiAck> {
    if (this.outage) throw new AdapterUnavailable("nacha", "odfi_portal_upload");
    const fileId = createHash("sha256").update(content).digest("hex").slice(0, 16);
    if (this.files.has(fileId)) return { fileId, status: "accepted", duplicate: true };
    const lines = content.split("\n").filter(Boolean);
    if (lines.some((l) => l.length !== 94)) return { fileId, status: "rejected", duplicate: false, reason: "record length ≠ 94" };
    if (lines[0]?.[0] !== "1" || !lines.some((l) => l[0] === "9")) return { fileId, status: "rejected", duplicate: false, reason: "missing file header/control" };
    this.files.set(fileId, { fileName, at: now });
    return { fileId, status: "accepted", duplicate: false };
  }
  async returns(since: string): Promise<readonly AchReturn[]> {
    if (this.outage) throw new AdapterUnavailable("nacha", "odfi_portal_upload");
    return this.returnFiles.filter((r) => r.at >= since).flatMap((r) => parseAchReturns(r.content));
  }
}
/** Next transmission window at/after `localHHmm`, else the first window tomorrow (2.3: "retransmit within the window, else next window and reschedule settlement"). */
export function nextWindow(windows: readonly string[], localHHmm: string): { hhmm: string; tomorrow: boolean } {
  const w = [...windows].sort().find((x) => x >= localHHmm);
  return w ? { hhmm: w, tomorrow: false } : { hhmm: [...windows].sort()[0]!, tomorrow: true };
}
