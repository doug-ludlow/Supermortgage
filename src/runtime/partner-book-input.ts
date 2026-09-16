/**
 * 33.1 inputs on the wire — the one reader of a partner-book upload body, lifted out of src/runtime/server.ts so the staff
 * route (`POST /v1/partner-book/imports`, 33.1 / 34.3) and the partner route (`POST /v1/partner/book/imports`, 36.2) parse
 * the same multipart or JSON body and no second reader exists.
 *
 *   readPartnerBookFiles   multipart/form-data (fields + files `tape`, `supplement`) or JSON `{…, tape: {filename, content_base64 | content},
 *                          supplement?}` → the fields as named and the two files; decides nothing about who the partner is.
 *   partnerBookInput       the staff route's full input (33.1 Inputs and triggers): `partner` (JSON or a JSON string field), `as_of_date`,
 *                          `profile` (m3-v1 only) and the files — unchanged from the server's own reader.
 *
 * The partner route (src/runtime/partner-portal/book.ts) takes only `as_of_date` and the files from what readPartnerBookFiles returns
 * and builds `partner` from the session (36.2 rule 2): a `partner`, `partner_party_id`, `nmlsr_id` or `profile` field is dropped there.
 */
import type { IncomingMessage } from "node:http";
import { parseMultipart } from "./borrower/routes.ts";
import type { PartnerBookImportInput } from "./partner-book.ts";

export type UploadFile = { readonly filename: string; readonly content: Uint8Array };
export type PartnerBookFiles = { readonly fields: Record<string, unknown>; readonly tape: UploadFile | undefined; readonly supplement: UploadFile | undefined };

/** The same cap as the server's JSON reader: a transfer batch of a few thousand loans is tens of MB of CSV. */
export const MAX_UPLOAD_BODY = 64 * 1024 * 1024;

async function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > max) throw new RangeError(`request body over ${max} bytes`); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}
async function readJsonObject(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  const text = (await readRaw(req, max)).toString("utf8");
  if (!text) return {};
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new RangeError("request body must be a JSON object");
  return v as Record<string, unknown>;
}

/** The upload body as fields and files, from multipart or JSON; nothing here reads a partner. */
export async function readPartnerBookFiles(req: IncomingMessage, max: number = MAX_UPLOAD_BODY): Promise<PartnerBookFiles> {
  const ctype = String(req.headers["content-type"] ?? "");
  if (/^multipart\/form-data/i.test(ctype)) {
    const mp = parseMultipart(await readRaw(req, max), ctype);
    const files: Record<string, UploadFile> = {};
    for (const f of mp.files) files[f.field] = { filename: f.filename ?? `${f.field}.csv`, content: new Uint8Array(f.bytes) };
    return { fields: { ...mp.fields }, tape: files["tape"], supplement: files["supplement"] };
  }
  const fields = await readJsonObject(req, max);
  const file = (v: unknown, what: string): UploadFile | undefined => {
    if (!v || typeof v !== "object") return undefined;
    const o = v as Record<string, unknown>;
    const filename = typeof o["filename"] === "string" && o["filename"] ? o["filename"] : `${what}.csv`;
    if (typeof o["content_base64"] === "string") return { filename, content: new Uint8Array(Buffer.from(o["content_base64"], "base64")) };
    if (typeof o["content"] === "string") return { filename, content: new Uint8Array(Buffer.from(o["content"], "utf8")) };
    throw new RangeError(`${what} needs { filename, content_base64 }`);
  };
  return { fields, tape: file(fields["tape"], "tape"), supplement: file(fields["supplement"], "supplement") };
}

/** 33.1 inputs (the staff / machine route): JSON `{partner, as_of_date, profile, tape: {filename, content_base64}, supplement?}` or multipart fields `partner` (JSON), `as_of_date`, `profile` and files `tape`, `supplement`. */
export async function partnerBookInput(req: IncomingMessage): Promise<PartnerBookImportInput> {
  const { fields: raw, tape, supplement } = await readPartnerBookFiles(req);
  const fields: Record<string, unknown> = { ...raw, ...(typeof raw["partner"] === "string" && raw["partner"].trim().startsWith("{") ? { partner: JSON.parse(raw["partner"]) as unknown } : {}) };
  const partner = fields["partner"] as Record<string, unknown> | undefined;
  if (!partner || typeof partner !== "object" || typeof partner["legal_name"] !== "string" || !partner["legal_name"]) throw new RangeError("partner is required: { legal_name, nmlsr_id, servicer_number?, mers_org_id? }");
  if (typeof partner["nmlsr_id"] !== "string" || !partner["nmlsr_id"]) throw new RangeError("partner.nmlsr_id is required");
  if (typeof fields["as_of_date"] !== "string" || !fields["as_of_date"]) throw new RangeError("as_of_date is required (YYYY-MM-DD)");
  const profile = String(fields["profile"] ?? "m3-v1"); if (profile !== "m3-v1") throw new RangeError(`profile must be m3-v1 (got ${profile})`);
  if (!tape) throw new RangeError("tape is required (.xlsx or .csv)");
  return { partner: { legal_name: partner["legal_name"], nmlsr_id: partner["nmlsr_id"], ...(typeof partner["servicer_number"] === "string" && partner["servicer_number"] ? { servicer_number: partner["servicer_number"] } : {}), ...(typeof partner["mers_org_id"] === "string" && partner["mers_org_id"] ? { mers_org_id: partner["mers_org_id"] } : {}) },
    as_of_date: fields["as_of_date"], profile: "m3-v1", tape, ...(supplement ? { supplement } : {}) };
}
