import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  DOCUMENT_LIMITS,
  DocumentParseError,
  parseCsv,
  parseDocumentBytes,
  parseXlsx,
} from "../documents/document-parser-core.js";

function zipParts(parts) {
  return zipSync(Object.fromEntries(
    Object.entries(parts).map(([name, source]) => [name, strToU8(source)]),
  ));
}

function minimalXlsx({
  sheetXml = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Tên</t></is></c><c r="B1"><f>1+1</f><v>2</v></c></row><row r="2"><c r="A2"><v>7</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:A2"/></mergeCells></worksheet>`,
} = {}) {
  return zipParts({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dữ liệu" sheetId="1" state="hidden" r:id="rId1"/></sheets><definedNames><definedName name="MainRange">'Dữ liệu'!$A$1:$B$2</definedName></definedNames></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": sheetXml,
  });
}

function nonSpreadsheetOoxmlFixture() {
  return zipParts({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`,
  });
}

test("XLSX parser preserves sparse cells, formula, cached value, merge, hidden state, and names", () => {
  const workbook = parseXlsx(minimalXlsx(), { name: "fixture.xlsx" });
  assert.equal(workbook.structure.sheetCount, 1);
  assert.equal(workbook.sheets[0].state, "hidden");
  assert.equal(workbook.sheets[0].populatedCellCount, 3);
  assert.deepEqual(workbook.sheets[0].merges, ["A1:A2"]);
  assert.equal(workbook.sheets[0].cells.find((cell) => cell.address === "B1").formula, "1+1");
  assert.equal(workbook.sheets[0].cells.find((cell) => cell.address === "B1").cachedResult, "2");
  assert.equal(workbook.definedNames[0].name, "MainRange");
  assert.match(workbook.normalizedText, /Tên/);
});

test("CSV parser handles UTF-8 BOM, delimiter detection, quotes, and multiline cells", () => {
  const csv = new Uint8Array([
    0xef, 0xbb, 0xbf,
    ...strToU8("Tên;Ghi chú\r\nAn;\"dòng 1\ndòng 2\"\r\nBình;\"a; b\""),
  ]);
  const document = parseCsv(csv, { name: "fixture.csv" });
  assert.equal(document.delimiter, ";");
  assert.equal(document.sheets[0].rowCount, 3);
  assert.equal(document.sheets[0].cells.find((cell) => cell.address === "B2").value, "dòng 1\ndòng 2");
});

test("CSV parser falls back to Windows-1258", () => {
  const document = parseCsv(Uint8Array.from([84, 0xea, 110, 44, 49]), { name: "legacy.csv" });
  assert.equal(document.sheets[0].cells[0].value, "Tên");
});

test("Excel Understand worker rejects non-spreadsheet OOXML input", () => {
  assert.throws(
    () => parseDocumentBytes(nonSpreadsheetOoxmlFixture(), { name: "fixture.docx", kind: "docx" }),
    (error) => error.code === "unsupported_type",
  );
});

test("parsers reject empty, renamed, malformed, oversized, and encrypted inputs clearly", () => {
  assert.throws(() => parseCsv(new Uint8Array()), (error) => error.code === "empty_file");
  assert.throws(() => parseCsv(minimalXlsx()), (error) => error.code === "signature_mismatch");
  assert.throws(
    () => parseXlsx(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])),
    (error) => error instanceof DocumentParseError && error.code === "invalid_archive",
  );
  assert.throws(
    () => parseXlsx(minimalXlsx(), {
      limits: { ...DOCUMENT_LIMITS, maxArchiveBytes: 20 },
    }),
    (error) => error.code === "archive_limit",
  );
  assert.throws(
    () => parseXlsx(minimalXlsx(), {
      limits: { ...DOCUMENT_LIMITS, maxWorkbookCells: 1 },
    }),
    (error) => error.code === "cell_limit",
  );
  assert.throws(
    () => parseCsv(strToU8("header\nlong value"), {
      limits: { ...DOCUMENT_LIMITS, maxDocumentCharacters: 5 },
    }),
    (error) => error.code === "character_limit",
  );
  const encrypted = minimalXlsx().slice();
  const view = new DataView(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);
  for (let offset = 0; offset + 46 < encrypted.length; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint16(offset + 8, view.getUint16(offset + 8, true) | 1, true);
      break;
    }
  }
  assert.throws(() => parseXlsx(encrypted), (error) => error.code === "encrypted_archive");
});

test("all six repository workbook samples parse when the local fixture directory is present", async (t) => {
  const directories = await readdir(process.cwd(), { withFileTypes: true });
  let fixtureDirectory = "";
  let workbookNames = [];
  for (const entry of directories) {
    if (!entry.isDirectory()) continue;
    const names = await readdir(entry.name).catch(() => []);
    const workbooks = names.filter((name) => name.endsWith(".xlsx"));
    if (workbooks.length >= 6) {
      fixtureDirectory = entry.name;
      workbookNames = workbooks;
      break;
    }
  }
  if (!fixtureDirectory) {
    t.skip("The local workbook sample directory is not present.");
    return;
  }
  assert.equal(workbookNames.length, 6);
  const parsed = [];
  for (const name of workbookNames) {
    parsed.push(parseXlsx(
      await readFile(path.join(fixtureDirectory, name)),
      { name },
    ));
  }
  assert.ok(parsed.every((workbook) => workbook.structure.sheetCount >= 1));
  assert.ok(parsed.some((workbook) => workbook.structure.sheetCount === 9));
  assert.ok(parsed.some((workbook) =>
    workbook.structure.sheets.some((sheet) => /:IX\d+$/i.test(sheet.usedRange))));
  assert.ok(parsed.find((workbook) => workbook.name === "Feature_ list.xlsx"));
  assert.ok(parsed.some((workbook) =>
    workbook.sheets.some((sheet) => sheet.cells.some((cell) => cell.formula))));
});
