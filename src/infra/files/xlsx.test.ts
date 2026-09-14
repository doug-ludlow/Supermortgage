import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { readXlsx, writeXlsx, excelSerialToIsoDate, isoDateToExcelSerial, crc32, zip, unzip, columnIndex, columnLetters, XLSX_PART_MAX } from "./xlsx.ts";

const enc = new TextEncoder();

test("xlsx: writeXlsx → readXlsx round-trips 3 rows × 5 columns (escaped text, unicode, numbers, booleans, empty cells)", () => {
  const rows: (string | number | boolean | null)[][] = [
    ["Servicer Loan #", "Borrower & Co <name>", "UPB", "Active?", "Note"],
    ["NL-100001", "María García <\"Señora\"> & 'friends'", 441366.13, true, ""],
    [null, "日本語 — ünïcödé ✓", 0, false, "  leading and trailing  "],
  ];
  const bytes = writeXlsx(rows, "Tape");
  // Zip magic + entry names + a valid CRC per entry.
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b);
  const entries = unzip(bytes);
  assert.deepEqual([...entries.keys()], ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"]);
  const sheetXml = new TextDecoder().decode(entries.get("xl/worksheets/sheet1.xml")!);
  assert.match(sheetXml, /<c r="B1" t="inlineStr"><is><t>Borrower &amp; Co &lt;name&gt;<\/t><\/is><\/c>/);
  assert.match(sheetXml, /<c r="C2"><v>441366.13<\/v><\/c>/);
  assert.match(sheetXml, /<c r="D2" t="b"><v>1<\/v><\/c>/);
  assert.match(sheetXml, /<c r="D3" t="b"><v>0<\/v><\/c>/);
  assert.doesNotMatch(sheetXml, /r="A3"/);          // null cell omitted
  assert.doesNotMatch(sheetXml, /r="E2"/);          // "" cell omitted

  const wb = readXlsx(bytes);
  assert.equal(wb.sheets.length, 1);
  assert.equal(wb.sheets[0]!.name, "Tape");
  assert.deepEqual(wb.sheets[0]!.rows, [
    ["Servicer Loan #", "Borrower & Co <name>", "UPB", "Active?", "Note"],
    ["NL-100001", "María García <\"Señora\"> & 'friends'", "441366.13", "TRUE"],
    ["", "日本語 — ünïcödé ✓", "0", "FALSE", "  leading and trailing  "],
  ]);
  // Every cell of a gap-filled row reads as a string.
  assert.equal(wb.sheets[0]!.rows[2]![0], "");
});

test("xlsx: reads a hand-built shared-strings workbook (rich-text runs, phonetic runs, str/n/b/e cells, row and column gaps, namespace prefixes)", () => {
  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
  <si><t>Servicer Loan Number</t></si>
  <si><r><rPr><b/></rPr><t>Maria</t></r><r><t xml:space="preserve"> Garcia</t></r></si>
  <si><t>Tom &amp; Jerry &lt;3</t><rPh sb="0" eb="3"><t>IGNORED</t></rPh><phoneticPr fontId="1"/></si>
  <si><t/></si>
</sst>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <x:sheetData>
    <x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="C1" t="s"><x:v>1</x:v></x:c></x:row>
    <x:row r="3">
      <x:c r="A3" t="s"><x:v>2</x:v></x:c>
      <x:c r="B3" t="n"><x:v>45920</x:v></x:c>
      <x:c r="C3"><x:v>0.0725</x:v></x:c>
      <x:c r="D3" t="b"><x:v>1</x:v></x:c>
      <x:c r="E3" t="str"><x:f>A3&amp;"!"</x:f><x:v>Tom &amp; Jerry &lt;3!</x:v></x:c>
      <x:c r="F3" t="e"><x:v>#N/A</x:v></x:c>
      <x:c r="G3" s="2"/>
      <x:c r="H3" t="s"><x:v>3</x:v></x:c>
      <x:c r="I3" t="inlineStr"><x:is><x:t>inline &#169; &#x263A;</x:t></x:is></x:c>
    </x:row>
  </x:sheetData>
</x:worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Book &amp; Tape" sheetId="7" r:id="rId9"/><sheet name="Empty" sheetId="8" r:id="rId10"/></sheets>
</workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/other.xml"/>
  <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/tape.xml"/>
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;
  const empty = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`;
  const bytes = zip([
    { name: "[Content_Types].xml", data: enc.encode(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`) },
    { name: "xl/workbook.xml", data: enc.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(rels) },
    { name: "xl/sharedStrings.xml", data: enc.encode(sst) },
    { name: "xl/worksheets/tape.xml", data: enc.encode(sheet) },
    { name: "xl/worksheets/other.xml", data: enc.encode(empty) },
  ]);
  const wb = readXlsx(bytes);
  assert.deepEqual(wb.sheets.map((s) => s.name), ["Book & Tape", "Empty"]);
  assert.deepEqual(wb.sheets[0]!.rows, [
    ["Servicer Loan Number", "", "Maria Garcia"],
    [],
    ["Tom & Jerry <3", "45920", "0.0725", "TRUE", "Tom & Jerry <3!", "#N/A", "", "", "inline © ☺"],
  ]);
  assert.deepEqual(wb.sheets[1]!.rows, []);
});

test("xlsx: zip layer — stored (method 0) entries, CRC32 of a known vector, and the central directory offsets", () => {
  assert.equal(crc32(enc.encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  const payload = enc.encode("hello, zip");
  // A stored-entry zip built by hand: local header, data, central directory, EOCD.
  const name = enc.encode("a.txt");
  const le16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
  const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const crc = crc32(payload);
  const local = [...le32(0x04034b50), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(crc), ...le32(payload.length), ...le32(payload.length), ...le16(name.length), ...le16(0), ...name, ...payload];
  const cd = [...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(crc), ...le32(payload.length), ...le32(payload.length), ...le16(name.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(0), ...name];
  const eocd = [...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(1), ...le16(1), ...le32(cd.length), ...le32(local.length), ...le16(0)];
  const stored = unzip(new Uint8Array([...local, ...cd, ...eocd]));
  assert.equal(new TextDecoder().decode(stored.get("a.txt")!), "hello, zip");
  // The writer's entries inflate back to the original and carry the right CRC/sizes.
  const z = zip([{ name: "x/y.xml", data: payload }, { name: "z.xml", data: enc.encode("<z/>") }]);
  assert.equal(z.length > 0, true);
  const back = unzip(z);
  assert.deepEqual([...back.keys()], ["x/y.xml", "z.xml"]);
  assert.deepEqual(back.get("x/y.xml"), payload);
  const comp = deflateRawSync(payload, { level: 6 });
  const idx = Buffer.from(z).indexOf(Buffer.from(comp));
  assert.equal(idx > 0, true, "deflate-raw body stored verbatim");
  // Local header fields: method 8, crc, compressed and uncompressed sizes.
  const view = new DataView(z.buffer, z.byteOffset, z.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(8, true), 8);
  assert.equal(view.getUint32(14, true), crc);
  assert.equal(view.getUint32(18, true), comp.length);
  assert.equal(view.getUint32(22, true), payload.length);
});

test("xlsx: A1 column arithmetic", () => {
  assert.equal(columnIndex("A"), 0); assert.equal(columnIndex("Z"), 25); assert.equal(columnIndex("AA"), 26); assert.equal(columnIndex("DN"), 117);
  assert.equal(columnLetters(0), "A"); assert.equal(columnLetters(25), "Z"); assert.equal(columnLetters(26), "AA"); assert.equal(columnLetters(117), "DN");
  for (let i = 0; i < 1000; i++) assert.equal(columnIndex(columnLetters(i)), i);
});

test("xlsx: excelSerialToIsoDate — 1900 date system with the Lotus leap-year bug", () => {
  assert.equal(excelSerialToIsoDate(25569), "1970-01-01");
  // 45900 − 25569 = 20331 days after 1970-01-01; 1970..2024 = 55 years with 14 leap days = 20089 days → 2025-01-01;
  // 20331 − 20089 = 242 → the 243rd day of 2025 (Jan 31, Feb 59, Mar 90, Apr 120, May 151, Jun 181, Jul 212, Aug 243) = 2025-08-31.
  assert.equal(excelSerialToIsoDate(45900), "2025-08-31");
  assert.equal(excelSerialToIsoDate(45920), "2025-09-20");
  assert.equal(excelSerialToIsoDate(60), "1900-02-29");   // the phantom day, tolerated
  assert.equal(excelSerialToIsoDate(59), "1900-02-28");
  assert.equal(excelSerialToIsoDate(61), "1900-03-01");
  assert.equal(excelSerialToIsoDate(1), "1900-01-01");
  assert.equal(excelSerialToIsoDate(45920.75), "2025-09-20"); // time-of-day fraction dropped
  assert.equal(excelSerialToIsoDate(46266), "2026-09-01");
  assert.equal(isoDateToExcelSerial("2025-09-20"), 45920);
  assert.equal(isoDateToExcelSerial("1970-01-01"), 25569);
  assert.equal(isoDateToExcelSerial("1900-01-01"), 1);
  assert.equal(isoDateToExcelSerial("1900-02-28"), 59);
  assert.equal(isoDateToExcelSerial("1900-03-01"), 61);
  for (const s of [1, 59, 61, 100, 25569, 36526, 45920, 60000]) assert.equal(isoDateToExcelSerial(excelSerialToIsoDate(s)), s);
});

test("xlsx: bounds — a deflate bomb (1000:1 part whose declared size lies), a part declared past XLSX_PART_MAX, and a sheet past Excel's row/column limits all throw RangeError before allocating", () => {
  const CD = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const patchDeclaredSize = (z: Uint8Array, size: number): Uint8Array => {
    const out = new Uint8Array(z); const cd = Buffer.from(out).indexOf(CD); assert.ok(cd > 0, "the central directory");
    new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(cd + 24, size, true); return out;
  };
  // 1 MB of zeros deflates to about 1 KB (≈ 1000:1); the central directory claims 1,000 bytes so `maxOutputLength` cuts the inflate off there.
  const bomb = zip([{ name: "xl/worksheets/sheet1.xml", data: new Uint8Array(1024 * 1024) }]);
  assert.ok(bomb.length < 2048, `the bomb is small on the wire (${bomb.length} bytes)`);
  assert.throws(() => unzip(patchDeclaredSize(bomb, 1000)), (e: unknown) => e instanceof RangeError && /does not inflate to its declared 1000 bytes/.test((e as Error).message));
  // an honest declared size past the per-part cap is refused before a byte is inflated
  assert.throws(() => unzip(patchDeclaredSize(bomb, XLSX_PART_MAX + 1)), (e: unknown) => e instanceof RangeError && /over the .*-byte limit/.test((e as Error).message));
  // a declared size that is too small for the real part is a corrupt part, never a partial read
  assert.throws(() => unzip(patchDeclaredSize(zip([{ name: "a.xml", data: enc.encode("<a/>") }]), 3)), RangeError);
  // the honest workbook still reads
  assert.equal(unzip(bomb).get("xl/worksheets/sheet1.xml")!.length, 1024 * 1024);
  // a sheet whose <row r> or <c r> points past Excel's own limits never grows the arrays
  const workbook = (sheetXml: string): Uint8Array => zip([
    { name: "xl/workbook.xml", data: enc.encode(`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`) },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode(`<worksheet><sheetData>${sheetXml}</sheetData></worksheet>`) },
  ]);
  assert.throws(() => readXlsx(workbook(`<row r="1000000000"><c r="A1000000000"><v>1</v></c></row>`)), (e: unknown) => e instanceof RangeError && /row 1000000000 is past Excel's 1048576-row limit/.test((e as Error).message));
  assert.throws(() => readXlsx(workbook(`<row r="1"><c r="XFE1"><v>1</v></c></row>`)), (e: unknown) => e instanceof RangeError && /column 16385 is past Excel's 16384-column limit/.test((e as Error).message));
  assert.deepEqual(readXlsx(workbook(`<row r="1048576"><c r="XFD1048576"><v>1</v></c></row>`)).sheets[0]!.rows.length, 1048576, "Excel's last cell still reads");
});
