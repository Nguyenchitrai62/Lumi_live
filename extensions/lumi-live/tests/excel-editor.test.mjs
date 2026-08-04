import assert from "node:assert/strict";
import test from "node:test";
import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
} from "fflate";
import { editXlsxBytes } from "../documents/excel-editor-core.js";
import { parseXlsx } from "../documents/document-parser-core.js";

function minimalEditableXlsx({
  sheetXml = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:H39"/><sheetData><row r="1"><c r="A1" s="1" t="inlineStr"><is><t>Original</t></is></c></row><row r="4"><c r="H4"><v>1</v></c></row><row r="39"><c r="H39"><v>2</v></c></row></sheetData></worksheet>`,
} = {}) {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
    "xl/calcChain.xml": strToU8(`<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="A1" i="1"/></calcChain>`),
    "docProps/custom.xml": strToU8("preserve-this-part-byte-for-byte"),
  });
}

test("XLSX editor applies formula and scalar edits while preserving unrelated archive parts", () => {
  const original = minimalEditableXlsx();
  const edited = editXlsxBytes(original, [{
    operation: "set_formula",
    sheet: "Data",
    cell: "H40",
    formula: "=SUM(H4:H39)",
  }, {
    operation: "set_value",
    sheet: "Data",
    cell: "B2",
    value: "Hello & <world>",
    valueType: "string",
  }, {
    operation: "set_value",
    sheet: "Data",
    cell: "C3",
    value: "12.5",
    valueType: "number",
  }, {
    operation: "set_value",
    sheet: "Data",
    cell: "D3",
    value: "true",
    valueType: "boolean",
  }, {
    operation: "clear",
    sheet: "Data",
    cell: "A1",
  }]);

  const workbook = parseXlsx(edited.bytes, { name: "edited.xlsx" });
  const cells = new Map(workbook.sheets[0].cells.map((cell) => [cell.address, cell]));
  assert.equal(cells.get("H40").formula, "SUM(H4:H39)");
  assert.equal(cells.get("H40").cachedResult, "");
  assert.equal(cells.get("B2").value, "Hello & <world>");
  assert.equal(cells.get("C3").value, "12.5");
  assert.equal(cells.get("D3").value, "TRUE");
  assert.equal(cells.has("A1"), false);

  const entries = unzipSync(edited.bytes);
  assert.equal(strFromU8(entries["docProps/custom.xml"]), "preserve-this-part-byte-for-byte");
  assert.equal(entries["xl/calcChain.xml"], undefined);
  assert.doesNotMatch(strFromU8(entries["xl/_rels/workbook.xml.rels"]), /calcChain/);
  assert.doesNotMatch(strFromU8(entries["[Content_Types].xml"]), /calcChain/);
  const sheetXml = strFromU8(entries["xl/worksheets/sheet1.xml"]);
  assert.match(sheetXml, /<c r="A1" s="1"\/>/);
  assert.match(sheetXml, /<dimension ref="A1:H40"\/>/);
  const workbookXml = strFromU8(entries["xl/workbook.xml"]);
  assert.match(workbookXml, /calcMode="auto"/);
  assert.match(workbookXml, /fullCalcOnLoad="1"/);
  assert.equal(edited.applied.length, 5);
});

test("XLSX editor rejects edits that could corrupt complex worksheet structures", () => {
  const sharedFormula = minimalEditableXlsx({
    sheetXml: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="B1"><f t="shared" si="0" ref="B1:B2">A1</f><v>1</v></c></row><row r="2"><c r="B2"><f t="shared" si="0"/><v>2</v></c></row></sheetData></worksheet>`,
  });
  assert.throws(
    () => editXlsxBytes(sharedFormula, [{
      operation: "set_value",
      sheet: "Data",
      cell: "B2",
      value: "3",
      valueType: "number",
    }]),
    (error) => error.code === "protected_formula_range",
  );

  const merged = minimalEditableXlsx({
    sheetXml: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>`,
  });
  assert.throws(
    () => editXlsxBytes(merged, [{
      operation: "clear",
      sheet: "Data",
      cell: "B1",
    }]),
    (error) => error.code === "merged_cell",
  );

  assert.throws(
    () => editXlsxBytes(minimalEditableXlsx(), [{
      operation: "set_formula",
      sheet: "Data",
      cell: "A2",
      formula: "WEBSERVICE(\"https://example.com\")",
    }]),
    (error) => error.code === "unsafe_formula",
  );
});

test("XLSX editor rejects duplicate cells and keeps the source buffer unchanged", () => {
  const source = minimalEditableXlsx();
  const original = source.slice();
  assert.throws(
    () => editXlsxBytes(source, [{
      operation: "clear",
      sheet: "Data",
      cell: "A1",
    }, {
      operation: "set_value",
      sheet: "Data",
      cell: "A1",
      value: "replacement",
    }]),
    (error) => error.code === "duplicate_cell",
  );
  assert.deepEqual(source, original);
});
