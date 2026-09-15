/**
 * The FAKE lockbox remittance layout (§35.5 rule 7; Integrations `lockbox`: "the in-repo FAKE lockbox emits the same layout so the
 * parser is one codec"). One pipe-delimited text file per lockbox per servicer business day:
 *
 *   H|<lockbox_id>|<file_date>|<item_count>|<control_total_cents>
 *   D|<item_no>|<scanline>|<amount_cents>|<check_no>|<payer>|<scanned_at ISO>|<image_name>
 *   T|<sha256 of the D lines>
 *
 * `encodeRemittance` writes it (the FAKE bank's queue and the tests), `parseRemittance` reads it: a header/trailer that does not
 * describe the detail lines is a `RemittanceError` (FILE_INVALID); a control total that does not equal Σ amount_cents is NOT an error
 * here — it is the batch's variance, the ingest's decision (rule 7: `status = variance`, officer). Money is bigint cents.
 *
 * [layout UNVERIFIED until the bank's spec is signed: OCR-A scanline positions, the control-record format and image naming are the
 * bank's — the Operational prerequisites of 35.5; the BAI2 path (src/infra/integrations/codecs/bai2.ts, banking.ts FakeLockbox,
 * src/domain/cashiering/ops-2-1.ts) stays for 2.1/6.x.]
 */
import { createHash } from "node:crypto";
import { plainDate, type PlainDate } from "../../../kernel/calendar/date.ts";
import type { Cents } from "../../../kernel/money/cents.ts";

export interface RemittanceItem {
  readonly item_no: number; readonly scanline: string; readonly amount_cents: Cents; readonly check_no: string; readonly payer: string;
  /** The scan instant (ISO); the cut-off test reads it in the lockbox's zone (2.1 rule 1). */
  readonly scanned_at: string; readonly image_name: string;
}
export interface RemittanceFile { readonly lockbox_id: string; readonly file_date: PlainDate; readonly item_count: number; readonly control_total_cents: Cents; readonly items: readonly RemittanceItem[]; readonly detail_sha256: string; }
export interface RemittanceInput { readonly lockbox_id: string; readonly file_date: PlainDate | string; readonly items: readonly (Omit<RemittanceItem, "image_name"> & { readonly image_name?: string })[]; /** Defaults to Σ amount_cents; a different figure encodes a variance file. */ readonly control_total_cents?: Cents; }

export class RemittanceError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.name = "RemittanceError"; this.code = code; } }

const FIELD_RE = /[|\r\n]/;
const field = (name: string, v: string): string => { if (FIELD_RE.test(v)) throw new RemittanceError("FILE_INVALID", `remittance field ${name} may not contain '|' or a line break`); return v; };
const detailLine = (it: Omit<RemittanceItem, "image_name"> & { readonly image_name?: string }): string => {
  if (!Number.isInteger(it.item_no) || it.item_no < 1) throw new RemittanceError("FILE_INVALID", `item_no must be a positive integer (${String(it.item_no)})`);
  if (it.amount_cents <= 0n) throw new RemittanceError("FILE_INVALID", `item ${it.item_no}: amount_cents must be positive`);
  if (Number.isNaN(Date.parse(it.scanned_at))) throw new RemittanceError("FILE_INVALID", `item ${it.item_no}: scanned_at must be an ISO instant`);
  return ["D", String(it.item_no), field("scanline", it.scanline), it.amount_cents.toString(), field("check_no", it.check_no), field("payer", it.payer), field("scanned_at", it.scanned_at), field("image_name", it.image_name ?? `${it.item_no}.tif`)].join("|");
};
export const detailSha256 = (lines: readonly string[]): string => createHash("sha256").update(lines.join("\n")).digest("hex");

/** The file text for a lockbox's day: header, one D line per item (by item_no), the trailer over the D lines. */
export function encodeRemittance(f: RemittanceInput): string {
  const fileDate = plainDate(String(f.file_date));
  const items = [...f.items].sort((a, b) => a.item_no - b.item_no);
  const seen = new Set<number>();
  for (const it of items) { if (seen.has(it.item_no)) throw new RemittanceError("FILE_INVALID", `duplicate item_no ${it.item_no}`); seen.add(it.item_no); }
  const details = items.map(detailLine);
  const control = f.control_total_cents ?? items.reduce((s, it) => s + it.amount_cents, 0n);
  const header = ["H", field("lockbox_id", f.lockbox_id), fileDate, String(items.length), control.toString()].join("|");
  return [header, ...details, `T|${detailSha256(details)}`].join("\n") + "\n";
}

const CENTS_RE = /^-?\d{1,15}$/;
/** Parse the FAKE layout; every structural defect is a RemittanceError (FILE_INVALID) — a control-total variance is not one. */
export function parseRemittance(text: string): RemittanceFile {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) throw new RemittanceError("FILE_INVALID", "a remittance file needs a header and a trailer");
  const h = lines[0]!.split("|"); const t = lines[lines.length - 1]!.split("|");
  if (h[0] !== "H" || h.length !== 5) throw new RemittanceError("FILE_INVALID", `bad header record: ${lines[0]}`);
  if (t[0] !== "T" || t.length !== 2 || !/^[0-9a-f]{64}$/.test(t[1]!)) throw new RemittanceError("FILE_INVALID", `bad trailer record: ${lines[lines.length - 1]}`);
  const details = lines.slice(1, -1);
  if (detailSha256(details) !== t[1]) throw new RemittanceError("FILE_INVALID", "trailer sha256 does not cover the detail records");
  const itemCount = Number(h[3]);
  if (!Number.isInteger(itemCount) || itemCount !== details.length) throw new RemittanceError("FILE_INVALID", `header names ${h[3]} items, the file carries ${details.length}`);
  if (!CENTS_RE.test(h[4] ?? "")) throw new RemittanceError("FILE_INVALID", `bad control total: ${h[4]}`);
  let fileDate: PlainDate;
  try { fileDate = plainDate(h[2]!); } catch { throw new RemittanceError("FILE_INVALID", `bad file date: ${h[2]}`); }
  const seen = new Set<number>();
  const items: RemittanceItem[] = details.map((line) => {
    const d = line.split("|");
    if (d[0] !== "D" || d.length !== 8) throw new RemittanceError("FILE_INVALID", `bad detail record: ${line}`);
    const item_no = Number(d[1]);
    if (!Number.isInteger(item_no) || item_no < 1 || seen.has(item_no)) throw new RemittanceError("FILE_INVALID", `bad or duplicate item_no: ${d[1]}`);
    seen.add(item_no);
    if (!CENTS_RE.test(d[3]!) || BigInt(d[3]!) <= 0n) throw new RemittanceError("FILE_INVALID", `item ${item_no}: bad amount ${d[3]}`);
    if (Number.isNaN(Date.parse(d[6]!))) throw new RemittanceError("FILE_INVALID", `item ${item_no}: bad scanned_at ${d[6]}`);
    return { item_no, scanline: d[2]!, amount_cents: BigInt(d[3]!), check_no: d[4]!, payer: d[5]!, scanned_at: new Date(Date.parse(d[6]!)).toISOString(), image_name: d[7]! };
  });
  return { lockbox_id: h[1]!, file_date: fileDate, item_count: itemCount, control_total_cents: BigInt(h[4]!), items, detail_sha256: t[1]! };
}
/** The file's own hash — the batch's `sha256` and the idempotency key of the whole file. */
export const remittanceSha256 = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
