"use client";
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { api } from "@/lib/api/client";
import { formatDate, formatDateTime, mask4, plural, words } from "@/lib/format";
import type { ImportListing, ImportResult, PartnerHolds, PartnerStatus } from "@/lib/types";
import { ErrorLine, useMe } from "@/components/Shell";
import { LoanLink, Tile } from "@/components/ui";

/** The Book page's two sentences (36.2 Outputs and artifacts; src/runtime/partner-portal/book.ts BOOK_COPY) — the API answers them too. */
const UPLOAD_COPY = "Uploading refreshes monitored facts. It does not transfer servicing.";
const EMPTY_COPY = "Upload a tape to open the book.";

export function BookView() {
  const me = useMe();
  const isAdmin = me.roles.includes("partner_admin");
  const [status, setStatus] = useState<PartnerStatus | null>(null);
  const [imports, setImports] = useState<ImportListing[] | null>(null);
  const [last, setLast] = useState<ImportResult | null>(null);
  const [holds, setHolds] = useState<PartnerHolds | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async (): Promise<void> => {
    try {
      const [s, i, h] = await Promise.all([api.status(), api.imports(), api.holds()]);
      setStatus(s); setImports(i.imports); setHolds(h);
      const newest = i.imports[0];
      setLast(newest ? await api.importReport(newest.import_id) : null);
    } catch (e) { setError(e); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorLine error={error} />;
  if (!status || !imports || !holds) return <p className="note">Loading…</p>;
  return (
    <div data-testid="book">
      <div className="page-head"><h1>Book</h1><span className="sub">{status.partner_legal_name}</span></div>
      <p className="note" data-testid="book-copy">{status.empty ? EMPTY_COPY : UPLOAD_COPY}</p>
      <div className="tiles">
        <Tile label="Book as of" value={formatDate(status.as_of_date)} small testId="book-as-of" />
        <Tile label="Next tape expected" value={<>{formatDate(status.next_expected)} {status.late ? <span className="chip bad">Late</span> : null}</>} small />
        <Tile label="Monitored loans" value={status.monitored_loans} testId="book-monitored" />
        <Tile label="On hold" value={status.on_hold} href="#holds" />
        <Tile label="Imports" value={status.imports} />
      </div>
      {isAdmin ? <Dropzone onDone={load} /> : <p className="note" data-testid="book-no-upload">Tape uploads are a partner admin's; this account reads the book.</p>}
      <h2>Last import</h2>
      {last ? <ImportReportPanel r={last} /> : <div className="empty">{EMPTY_COPY}</div>}
      <h2>History</h2>
      <div className="table-wrap">
        <table data-testid="book-history">
          <thead><tr><th>As of</th><th>Status</th><th className="num">Rows</th><th className="num">Loaded</th><th className="num">Loans created</th><th className="num">Invitations</th><th>Uploaded by</th><th>Uploaded at</th></tr></thead>
          <tbody>
            {imports.length ? imports.map((i) => (
              <tr key={i.import_id}><td>{formatDate(i.as_of_date)}</td><td><span className={`chip ${i.status === "loaded" ? "ok" : i.status === "rejected" ? "bad" : "muted"}`}>{words(i.status)}</span></td><td className="num">{i.rows_total}</td><td className="num">{i.rows_loaded}</td><td className="num">{i.loans_created}</td><td className="num">{i.invitations_sent}</td><td>{i.uploaded_by}</td><td>{formatDateTime(i.created_at)}</td></tr>
            )) : <tr><td colSpan={8} className="wrap"><span className="note">No import yet.</span></td></tr>}
          </tbody>
        </table>
      </div>
      <h2 id="holds">Holds</h2>
      <p className="note">Loans absent from the latest tape are held out of candidacy until Supermortgage staff resolve them; nothing here resolves a hold.</p>
      <div className="table-wrap">
        <table data-testid="book-holds">
          <thead><tr><th>Loan</th><th>Homeowner</th><th>State</th><th>Status</th><th>Last on tape</th><th>Latest tape</th><th>Held since</th></tr></thead>
          <tbody>
            {holds.holds.length ? holds.holds.map((h) => (
              <tr key={h.loan_id}><td><LoanLink loanId={h.loan_id} last4={h.servicer_loan_last4} /></td><td>{h.homeowner.name ?? "—"}</td><td>{h.state ?? "—"}</td><td><span className="chip warn">{words(h.status)}</span></td><td>{formatDate(h.last_as_of_date)}</td><td>{formatDate(h.partner_as_of_date)}</td><td>{formatDateTime(h.held_since)}</td></tr>
            )) : <tr><td colSpan={7} className="wrap"><span className="note">Nothing on hold.</span></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 36.2 rule 2: `as_of_date`, `tape`, `supplement` — the partner is the session's; no profile, no partner field. */
function Dropzone({ onDone }: { onDone: () => Promise<void> }) {
  const [asOf, setAsOf] = useState("");
  const [tape, setTape] = useState<File | null>(null);
  const [supplement, setSupplement] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const tapeInput = useRef<HTMLInputElement>(null);
  const onDrop = (ev: DragEvent<HTMLFormElement>): void => {
    ev.preventDefault(); setOver(false);
    for (const f of Array.from(ev.dataTransfer.files)) { if (/\.xlsx$/i.test(f.name) || (!tape && /\.csv$/i.test(f.name))) setTape(f); else if (/\.csv$/i.test(f.name)) setSupplement(f); }
  };
  const submit = (ev: FormEvent): void => {
    ev.preventDefault();
    if (!tape) { setError(new Error("Choose the tape (.xlsx or .csv)")); return; }
    const form = new FormData();
    form.set("as_of_date", asOf); form.set("tape", tape, tape.name);
    if (supplement) form.set("supplement", supplement, supplement.name);
    setBusy(true); setError(null); setResult(null);
    api.upload(form).then(async (r) => { setResult(r); await onDone(); }).catch(setError).finally(() => setBusy(false));
  };
  return (
    <form className={`dropzone${over ? " over" : ""}`} onSubmit={submit} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop} data-testid="upload">
      <h3 style={{ marginTop: 0 }}>Upload a tape</h3>
      <p className="note">Drop the tape (.xlsx or .csv) and, if you have one, the contact supplement (.csv), or choose them. {UPLOAD_COPY}</p>
      <div className="form">
        <div className="row">
          <label>As-of date<input type="date" required value={asOf} onChange={(e) => setAsOf(e.target.value)} data-testid="upload-as-of" /></label>
          <label>Tape<input ref={tapeInput} type="file" accept=".xlsx,.csv" required onChange={(e) => setTape(e.target.files?.[0] ?? null)} data-testid="upload-tape" /></label>
          <label>Supplement (optional)<input type="file" accept=".csv" onChange={(e) => setSupplement(e.target.files?.[0] ?? null)} data-testid="upload-supplement" /></label>
          <button className="btn" type="submit" disabled={busy} data-testid="upload-submit">{busy ? "Uploading…" : "Upload"}</button>
        </div>
      </div>
      <ErrorLine error={error} />
      {result ? <div style={{ marginTop: 12 }}><ImportReportPanel r={result} fresh /></div> : null}
    </form>
  );
}

function ImportReportPanel({ r, fresh }: { r: ImportResult; fresh?: boolean }) {
  const tone = r.status === "loaded" ? "ok" : r.status === "rejected" ? "bad" : "muted";
  const sentence = r.status === "loaded" ? "Loaded." : r.status === "already_loaded" ? "Already loaded: these files were imported before; nothing changed." : `Rejected: the tape's headers do not match the registered layout${r.report.rejected?.missing_headers.length ? ` (missing ${r.report.rejected.missing_headers.join(", ")})` : ""}.`;
  return (
    <div className="panel" data-testid={fresh ? "upload-result" : "last-import"} data-status={r.status}>
      <p style={{ marginTop: 0 }}><span className={`chip ${tone}`} data-testid={fresh ? "upload-status" : "last-import-status"}>{words(r.status)}</span> {sentence}</p>
      <dl className="facts">
        <dt>Rows</dt><dd>{r.rows_total} on the tape · {r.rows_loaded} loaded · {r.rows_exception} with exceptions</dd>
        <dt>Loans</dt><dd>{r.loans_created} created · {r.loans_updated} updated · {Math.max(0, r.loans.length - r.loans_created - r.loans_updated)} unchanged</dd>
        <dt>Homeowners</dt><dd>{r.parties_created} created · {r.parties_linked} linked</dd>
        <dt>Invitations</dt><dd>{r.invitations_sent} sent · {r.report.invitations?.filter((i) => i.held_reason).length ?? 0} held</dd>
        <dt>Supplement</dt><dd>{r.report.supplement ? `${r.report.supplement.rows} rows · ${r.report.supplement.matched} matched · ${r.report.supplement.orphans} orphans` : "—"}</dd>
        <dt>Now on hold</dt><dd>{r.report.not_on_tape?.length ? r.report.not_on_tape.map((n) => mask4(n.servicer_loan_number)).join(", ") : "none"}</dd>
        {r.created_at ? <><dt>Uploaded</dt><dd>{formatDateTime(r.created_at)}{r.uploaded_by ? ` by ${r.uploaded_by}` : ""}</dd></> : null}
      </dl>
      {r.report.exceptions?.length ? (
        <details style={{ marginTop: 8 }}><summary>{plural(r.report.exceptions.length, "exception", "exceptions")}</summary>
          <div className="table-wrap" style={{ marginTop: 8 }}><table><thead><tr><th>Row</th><th>Loan</th><th>Code</th><th>Field</th></tr></thead><tbody>
            {r.report.exceptions.map((x, i) => <tr key={i}><td>{x.row}</td><td className="mono">{x.servicer_loan_number ? mask4(x.servicer_loan_number) : "—"}</td><td>{words(x.code)}</td><td>{x.field ?? "—"}</td></tr>)}
          </tbody></table></div>
        </details>
      ) : null}
    </div>
  );
}
