// sm-pdf (src/infra/files/pdf.ts) — the writer's own unit cases: determinism, the WinAnsi round trip, the text layer's reading
// order, the page-model merge/stamp/append arithmetic, and "every authored notice version renders under sm-pdf" (35.2 risk #4:
// a template source with a character outside WinAnsi is a build defect, fixed in the authored file, never substituted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writePdf, textLayer, readOwnPdf, mergePdfs, stampPdf, appendPages, encodeWinAnsi, decodeWinAnsi, GlyphUnsupported, PdfNotOwn, writerStats, textWidth, contentStreams } from "./pdf.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { publishSection02 } from "../../notices/authored/section02.ts";
import { publishSection10 } from "../../domain/pmi/spec-harness.ts";
import { registerPreapprovalLetter } from "../../notices/authored/section20-3.ts";
import { NoticeService, RenderRefused } from "../../notices/service.ts";
import { MemoryArtifactSink } from "../../runtime/documents/notice-sink.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { MemoryEventStore, FixedClock } from "../../kernel/events/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { renderNoticePdf, blocksFromPlacements } from "../../domain/operations-runtime/documents/render.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";

const NOW = "2026-09-17T05:00:00.000Z";
const blocks = [
  { id: "amount_due", page: 1, yFraction: 0.05, pt: 16, bold: true, text: "Amount due $6,010.29 — payment due date October 1, 2026" },
  { id: "body", page: 1, yFraction: 0.2, pt: 10, bold: false, text: "Señor Peña — ¿está al día? Sí, año. " + "Lorem ipsum dolor sit amet. ".repeat(60) },
  { id: "p2", page: 2, yFraction: 0.1, pt: 10, bold: false, text: "page two (parenthesised) \\ backslash" },
];

test("sm-pdf: identical inputs give identical bytes; a PDF 1.4 header, FlateDecode streams, a fixed /ID and the clock's CreationDate", () => {
  const a = writePdf({ blocks, title: "t", idSeed: "seed", creationDate: NOW }); const b = writePdf({ blocks, title: "t", idSeed: "seed", creationDate: NOW });
  assert.ok(a.bytes.equals(b.bytes)); assert.equal(a.bytes.subarray(0, 8).toString("latin1"), "%PDF-1.4"); assert.equal(a.page_count, 2);
  const s = a.bytes.toString("latin1");
  assert.match(s, /\/Filter \/FlateDecode/); assert.match(s, /\/CreationDate \(D:20260917050000\+00'00'\)/); assert.match(s, /\/ID \[<[0-9a-f]{32}> <[0-9a-f]{32}>\]/); assert.match(s, /\/Producer \(sm-pdf\/1\)/);
  assert.notEqual(writePdf({ blocks, title: "t", idSeed: "other", creationDate: NOW }).bytes.toString("latin1"), s, "a different seed is a different /ID");
  assert.notEqual(writePdf({ blocks, title: "t", idSeed: "seed", creationDate: "2026-09-18T05:00:00.000Z" }).bytes.toString("latin1"), s, "a different clock is a different document");
  assert.equal(contentStreams(a.bytes).length, 2);
  // the cross-reference table: `startxref` points at `xref`, and every object's recorded offset is where `N 0 obj` begins (a reader that trusts the table finds every object)
  const tail = s.slice(s.lastIndexOf("startxref")); const startxref = Number(/startxref\s+(\d+)/.exec(tail)![1]);
  assert.equal(s.slice(startxref, startxref + 4), "xref");
  const table = /xref\s+0 (\d+)\s+([\s\S]*?)trailer/.exec(s.slice(startxref))!; const count = Number(table[1]!); const entries = table[2]!.trim().split(/\r?\n/);
  assert.equal(entries.length, count);
  for (let n = 1; n < count; n++) { const off = Number(entries[n]!.slice(0, 10)); assert.equal(s.slice(off, off + `${n} 0 obj`.length), `${n} 0 obj`, `object ${n} at its xref offset`); }
});

test("sm-pdf: the layout flows — no block overprints the one drawn before it on its page (a long 16 pt amount-due box pushes the blocks under it down; a first line that spills reports the page it was drawn on)", () => {
  const long = [
    { id: "amount_due", page: 1, yFraction: 0.05, pt: 16, bold: true, text: "Amount due $6,010.29 — payment due date October 1, 2026. " + "Your regular monthly payment is $2,946.79 ($2,334.29 principal and interest plus $612.50 escrow); $2,946.79 is past due for 1 payment and $116.71 in late charges is due. ".repeat(2) },
    { id: "late_fee", page: 1, yFraction: 0.1, pt: 10, bold: false, text: "If payment is received after October 16, 2026, a $116.71 late fee will be charged." },
    { id: "explanation", page: 1, yFraction: 0.13, pt: 10, bold: false, text: "Explanation of amount due. " + "Lorem ipsum dolor sit amet. ".repeat(40) },
    { id: "spill", page: 1, yFraction: 0.995, pt: 12, bold: false, text: "A block declared at the very bottom of page 1 is drawn on page 2." },
    { id: "p2", page: 2, yFraction: 0.02, pt: 10, bold: false, text: "Page two's own first block follows the spilled one." },
  ];
  const w = writePdf({ blocks: long, title: "flow", idSeed: "flow", creationDate: NOW });
  const own = readOwnPdf(w.bytes);
  for (const [p, page] of own.pages.entries()) for (let k = 1; k < page.ops.length; k++) assert.ok(page.ops[k]!.y < page.ops[k - 1]!.y, `page ${p + 1}: line ${k} (${page.ops[k]!.text.slice(0, 30)}) is below line ${k - 1}`);
  const by = Object.fromEntries(w.placements.map((x) => [x.block_id, x]));
  assert.ok(by["amount_due"]!.lines >= 3); assert.equal(by["late_fee"]!.page, 1); assert.equal(by["spill"]!.page, 2, "the placement reports the page the first line was drawn on"); assert.equal(by["p2"]!.page, 2);
  assert.deepEqual(textLayer(w.bytes).pages[1]!.split("\n").map((l) => l.slice(0, 7)), ["A block", "Page tw"], "page two: the spilled block, then page two's own");
  // a non-breaking space stays inside its word (never a split point, never substituted)
  const nb = writePdf({ blocks: [{ id: "nb", page: 1, yFraction: 0.1, pt: 10, bold: false, text: "October\u00a01,\u00a02026" }], title: "nb", idSeed: "nb", creationDate: NOW });
  assert.equal(readOwnPdf(nb.bytes).pages[0]!.ops.length, 1); assert.equal(textLayer(nb.bytes).text, "October\u00a01,\u00a02026");
});

test("sm-pdf: every WinAnsi code 32–255 round-trips through encode/decode; a character outside WinAnsi is refused naming the character and the block", () => {
  for (let code = 0x20; code <= 0xff; code++) {
    if ([0x7f, 0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(code)) continue;   // unassigned in WinAnsi
    const ch = decodeWinAnsi(Uint8Array.from([code])); assert.equal(encodeWinAnsi(ch, "b")[0], code, `code ${code}`);
  }
  assert.equal(decodeWinAnsi(encodeWinAnsi("ñ á ¿ — € “quotes” • ™", "b")), "ñ á ¿ — € “quotes” • ™");
  assert.throws(() => encodeWinAnsi("≥", "amount_due"), (e: unknown) => e instanceof GlyphUnsupported && e.code === "GLYPH_UNSUPPORTED" && e.char === "≥" && e.block_id === "amount_due" && /U\+2265/.test(e.message));
  assert.ok(textWidth(encodeWinAnsi("W", "b"), "F1", 10) > textWidth(encodeWinAnsi("i", "b"), "F1", 10), "AFM widths: W is wider than i");
});

test("sm-pdf: the text layer recovers the rendered text in reading order per page and per block; readOwnPdf refuses a foreign file", () => {
  const w = writePdf({ blocks, title: "t", idSeed: "seed", creationDate: NOW });
  const tl = textLayer(w.bytes);
  assert.equal(tl.pages.length, 2); assert.equal(tl.text, w.text);
  assert.deepEqual(tl.blocks.map((b) => [b.id, b.page]), [["amount_due", 1], ["body", 1], ["p2", 2]]);
  assert.ok(tl.blocks[1]!.text.startsWith("Señor Peña — ¿está al día? Sí, año."));
  assert.equal(tl.blocks[2]!.text, "page two (parenthesised) \\ backslash");
  const own = readOwnPdf(w.bytes); assert.equal(own.pages.length, 2); assert.equal(own.pages[0]!.ops[0]!.text, blocks[0]!.text); assert.equal(own.pages[0]!.ops[0]!.font, "F2");
  assert.throws(() => readOwnPdf(Buffer.from("%PDF-1.4\n%%EOF")), (e: unknown) => e instanceof PdfNotOwn);
});

test("sm-pdf: mergePdfs = a cover page per part plus the parts' pages; stampPdf and appendPages re-render with the stamps and pages in the text layer", () => {
  const w = writePdf({ blocks, title: "t", idSeed: "seed", creationDate: NOW });
  const m = mergePdfs([{ doc: w.bytes, cover: [{ font: "F2", pt: 14, x: 54, y: 700, text: "Cover A", block: "cover" }] }, { doc: w.bytes, cover: [{ font: "F1", pt: 10, x: 54, y: 700, text: "Cover B", block: "cover" }] }], { title: "m", creationDate: NOW, idSeed: "m" });
  assert.equal(m.page_count, 2 * w.page_count + 2); assert.equal(textLayer(m.bytes).pages[0], "Cover A"); assert.equal(textLayer(m.bytes).pages[w.page_count + 1], "Cover B");
  const st = stampPdf(w.bytes, [{ page: 1, x: 300, y: 100, text: "/s/ Bea Borrower", block: "sig1" }], { creationDate: NOW, idSeed: "s" });
  assert.equal(st.page_count, w.page_count); assert.ok(textLayer(st.bytes).pages[0]!.includes("/s/ Bea Borrower")); assert.notEqual(st.bytes.toString("latin1"), w.bytes.toString("latin1"));
  const ap = appendPages(w.bytes, [{ id: "signature_page", page: 1, yFraction: 0.05, pt: 12, bold: true, text: "Signature page" }], { creationDate: NOW, idSeed: "a" });
  assert.equal(ap.page_count, w.page_count + 1); assert.equal(textLayer(ap.bytes).pages.at(-1), "Signature page"); assert.equal(ap.placements[0]!.page, w.page_count + 1);
});

test("sm-pdf: every authored notice version renders under sm-pdf from its own sample payload (no template source carries a glyph outside WinAnsi)", () => {
  const before = writerStats().renders;
  const reg = buildRegistry(); publishAuthored(reg); publishSection02(reg); publishSection10(reg); registerPreapprovalLetter(reg);
  const failures: string[] = []; let rendered = 0;
  for (const code of reg.all().map((t) => t.code)) {
    for (const v of reg.versionsOf(code)) {
      if (v.plainLanguageStatus !== "counsel_approved") continue;
      try {
        const pdf = renderNoticePdf(v, v.samplePayload, { now: NOW }); assert.ok(pdf.page_count >= 1); assert.equal(textLayer(pdf.bytes).text, pdf.text); rendered++;
        for (const [p, page] of readOwnPdf(pdf.bytes).pages.entries()) for (let k = 1; k < page.ops.length; k++) assert.ok(page.ops[k]!.y < page.ops[k - 1]!.y, `${code}@${v.version} page ${p + 1}: line ${k} overprints line ${k - 1}`);
        // the checklist measured from the writer's placements (what was drawn) agrees with the block model's verdict for every published version
        const model = render(v.source, v.samplePayload);
        assert.equal(evaluateChecklist(v, v.samplePayload, { ...model, blocks: blocksFromPlacements(pdf.placements, model.blocks) }).passed, evaluateChecklist(v, v.samplePayload, model).passed, `${code}@${v.version}: the checklist from placements`);
      }
      catch (e) { failures.push(`${code}@${v.version}: ${(e as Error).message}`); }
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(rendered > 100, `rendered ${rendered} versions`);
  assert.equal(writerStats().renders - before, rendered);
});

test("sm-pdf: through NoticeService a glyph outside WinAnsi is a typed RenderRefused{GLYPH_UNSUPPORTED} naming the block — on every rendering path, not only documents.render", () => {
  const reg = buildRegistry(); publishAuthored(reg);
  const clock = new FixedClock(NOW); const events = new MemoryEventStore(clock);
  const svc = new NoticeService({ registry: reg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery(), artifacts: new MemoryArtifactSink(clock) });
  const v = reg.activeVersion("NTC_REGZ_41_STMT_STD", D("2026-09-17"))!;
  assert.throws(() => svc.render({ templateCode: "NTC_REGZ_41_STMT_STD", loanId: "L-glyph", recipients: [], payload: { ...v.samplePayload, suspense_instructions: "Saldo ≥ 12" }, asOf: D("2026-09-17") }),
    (e: unknown) => e instanceof RenderRefused && e.name === "RenderRefused" && e.code === "GLYPH_UNSUPPORTED" && e.blockId === "suspense" && e.char === "≥" && /block suspense/.test(e.message));
  assert.equal(events.all().length, 0, "nothing logged for a refused render");
});
