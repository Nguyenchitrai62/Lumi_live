import assert from "node:assert/strict";
import test from "node:test";
import {
  createExcelRegistry,
  LOCAL_EXCEL_PROVIDER,
} from "../documents/excel-registry.js";
import { configureMcpTools } from "../live/session-config.js";

function spreadsheetWorkbook(name, normalizedText) {
  const cells = [
    {
      address: "A1",
      row: 1,
      column: 1,
      type: "string",
      value: "Doanh thu",
      rawValue: "Doanh thu",
      formula: "",
      cachedResult: "",
      style: null,
      comment: "",
      hyperlink: null,
    },
    {
      address: "B1",
      row: 1,
      column: 2,
      type: "number",
      value: "42",
      rawValue: "42",
      formula: "40+2",
      cachedResult: "42",
      formulaType: "normal",
      formulaReference: "",
      sharedFormulaIndex: "0",
      style: { numberFormat: "#,##0", numberFormatKind: "" },
      comment: "",
      hyperlink: null,
    },
  ];
  return {
    kind: "xlsx",
    name,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    byteSize: 100,
    normalizedText,
    characterCount: normalizedText.length,
    structure: {
      sheetCount: 1,
      populatedCellCount: 2,
      sheets: [{ name: "Data", usedRange: "A1:B1", populatedCellCount: 2 }],
    },
    sheets: [{
      name: "Data",
      state: "visible",
      usedRange: "A1:B1",
      rowCount: 1,
      columnCount: 2,
      populatedCellCount: 2,
      cells,
      merges: [],
      drawings: [],
    }],
    definedNames: [],
  };
}

test("local Excel tools are always enabled and always allowed", () => {
  assert.equal(LOCAL_EXCEL_PROVIDER.localProvider, "excel");
  assert.deepEqual(
    LOCAL_EXCEL_PROVIDER.tools.map((tool) => tool.name),
    ["excel_understand", "excel_edit"],
  );
  assert.equal(LOCAL_EXCEL_PROVIDER.tools[0].permission, "allow");
  assert.equal(LOCAL_EXCEL_PROVIDER.tools[0].readOnly, true);
  assert.equal(LOCAL_EXCEL_PROVIDER.tools[1].permission, "allow");
  assert.equal(LOCAL_EXCEL_PROVIDER.tools[1].readOnly, false);
  assert.deepEqual(
    LOCAL_EXCEL_PROVIDER.tools[0].gemini.parameters.properties.mode.enum,
    ["overview", "read_range", "search", "formulas"],
  );
  const activeTools = new Map();
  const declarations = configureMcpTools({ servers: [] }, activeTools, [LOCAL_EXCEL_PROVIDER]);
  assert.equal(declarations.length, 2);
  assert.equal(activeTools.size, 2);
  const understand = declarations.find((declaration) => /excel_understand$/.test(declaration.name));
  const edit = declarations.find((declaration) => /excel_edit$/.test(declaration.name));
  assert.equal(activeTools.get(understand.name).localProvider, "excel");
  assert.equal(activeTools.get(understand.name).readOnly, true);
  assert.equal(activeTools.get(edit.name).permission, "allow");
  assert.equal(activeTools.get(edit.name).readOnly, false);
  assert.match(edit.description, /permission: always allow/);
});

test("turn context sends workbook metadata without inlining cell content", () => {
  const registry = createExcelRegistry();
  const small = registry.add(spreadsheetWorkbook("small.xlsx", "small private content"));
  const large = registry.add(spreadsheetWorkbook("large.xlsx", "x".repeat(200)));
  const context = registry.buildTurnContext(
    [small.workbookId, large.workbookId],
    "Analyze",
  );
  assert.doesNotMatch(context.prompt, /small private content/);
  assert.doesNotMatch(context.prompt, /x{100}/);
  assert.match(context.prompt, /small\.xlsx/);
  assert.match(context.prompt, /large\.xlsx/);
  assert.match(context.prompt, /excel_understand/);
  assert.equal(registry.get(small.workbookId).deliveryMode, "tool");
  assert.equal(registry.get(large.workbookId).deliveryMode, "tool");
});

test("overview returns a bounded workbook sample through the single tool", async () => {
  const registry = createExcelRegistry();
  const workbook = registry.add(spreadsheetWorkbook("report.xlsx", "private normalized data"));
  const overview = await registry.callTool("excel_understand", {
    workbookId: workbook.workbookId,
    mode: "overview",
    maxCells: 1,
  });
  assert.equal(overview.structuredContent.workbook.workbookId, workbook.workbookId);
  assert.equal(overview.structuredContent.cells.length, 1);
  assert.equal(overview.structuredContent.truncated, true);
  assert.equal(overview.structuredContent.continuation.cursor, 1);
  assert.doesNotMatch(JSON.stringify(overview), /private normalized data/);
});

test("read_range preserves formulas and paginates populated cells", async () => {
  const registry = createExcelRegistry();
  const workbook = registry.add(spreadsheetWorkbook("report.xlsx", "normalized"));
  const range = await registry.callTool("excel_understand", {
    workbookId: workbook.workbookId,
    mode: "read_range",
    sheet: "Data",
    range: "A1:B1",
    maxCells: 1,
  });
  assert.equal(range.structuredContent.locator, "report.xlsx • Data!A1:B1");
  assert.equal(range.structuredContent.cells.length, 1);
  assert.equal(range.structuredContent.continuation.cursor, 1);
  const continued = await registry.callTool("excel_understand", {
    workbookId: workbook.workbookId,
    mode: "read_range",
    sheet: "Data",
    range: "A1:B1",
    cursor: range.structuredContent.continuation.cursor,
    maxCells: 1,
  });
  assert.equal(continued.structuredContent.cells[0].formula, "40+2");
  assert.equal(continued.structuredContent.cells[0].cachedResult, "42");
  assert.equal(continued.structuredContent.continuation, null);
  assert.ok(JSON.stringify(continued).length < 64_000);
});

test("read_range safely accepts matching sheet-qualified A1 ranges", async () => {
  const registry = createExcelRegistry();
  const workbook = registry.add(spreadsheetWorkbook("report.xlsx", "normalized"));
  for (const qualifiedRange of ["Data!A1:B1", "'Data'!$A$1:$B$1"]) {
    const result = await registry.callTool("excel_understand", {
      workbookId: workbook.workbookId,
      mode: "read_range",
      sheet: "Data",
      range: qualifiedRange,
    });
    assert.equal(result.structuredContent.range, "A1:B1");
    assert.equal(result.structuredContent.cells.length, 2);
  }
});

test("read_range rejects a sheet-qualified range that conflicts with sheet", async () => {
  const registry = createExcelRegistry();
  const workbook = registry.add(spreadsheetWorkbook("report.xlsx", "normalized"));
  await assert.rejects(
    registry.callTool("excel_understand", {
      workbookId: workbook.workbookId,
      mode: "read_range",
      sheet: "Data",
      range: "Other!A1:B1",
    }),
    /does not match the requested sheet "Data"/,
  );
});

test("search finds workbook evidence and returns an exact locator", async () => {
  const registry = createExcelRegistry();
  const workbook = registry.add(spreadsheetWorkbook("report.xlsx", "normalized"));
  const result = await registry.callTool("excel_understand", {
    workbookId: workbook.workbookId,
    mode: "search",
    query: "40+2",
  });
  assert.equal(result.structuredContent.matches.length, 1);
  assert.equal(result.structuredContent.matches[0].locator, "report.xlsx • Data!B1");
});

test("formulas mode lists formula cells and preserves formula metadata", async () => {
  const registry = createExcelRegistry();
  const workbook = registry.add(spreadsheetWorkbook("report.xlsx", "normalized"));
  const result = await registry.callTool("excel_understand", {
    workbookId: workbook.workbookId,
    mode: "formulas",
    sheet: "Data",
  });
  assert.equal(result.structuredContent.totalFormulaCount, 1);
  assert.equal(result.structuredContent.formulas[0].address, "B1");
  assert.equal(result.structuredContent.formulas[0].formula, "40+2");
  assert.equal(result.structuredContent.formulas[0].sharedFormulaIndex, "0");
  assert.equal(result.structuredContent.continuation, null);
});

test("excel_edit updates session state and exports a separate XLSX copy", async () => {
  const source = spreadsheetWorkbook("report.xlsx", "normalized");
  source.sourceBytes = new ArrayBuffer(16);
  const registry = createExcelRegistry({
    editWorkbook: async (workbook, operations) => {
      const document = spreadsheetWorkbook(workbook.name, "edited normalized");
      document.sourceBytes = new ArrayBuffer(32);
      document.byteSize = 32;
      document.sheets[0].cells[1].formula = "SUM(A1:A2)";
      return {
        document,
        applied: operations.map((operation) => ({ ...operation })),
      };
    },
  });
  const workbook = registry.add(source, "workbook-1");
  const applied = await registry.callTool("excel_edit", {
    workbookId: workbook.workbookId,
    mode: "apply",
    operations: [{
      operation: "set_formula",
      sheet: "Data",
      cell: "B1",
      formula: "SUM(A1:A2)",
    }],
  });
  assert.equal(applied.structuredContent.revision, 1);
  assert.equal(applied.structuredContent.workbook.edited, true);
  assert.equal(applied.structuredContent.workbook.calculationPending, true);
  assert.equal(applied.structuredContent.recalculationRequired, true);
  assert.deepEqual(applied.structuredContent.applied, [{
    operation: "set_formula",
    sheet: "Data",
    cell: "B1",
  }]);
  assert.equal(registry.get(workbook.workbookId).sheets[0].cells[1].formula, "SUM(A1:A2)");

  const exported = await registry.callTool("excel_edit", {
    workbookId: workbook.workbookId,
    mode: "export",
    filename: "report:final",
  });
  assert.equal(exported.structuredContent.filename, "report-final.xlsx");
  assert.equal(exported.structuredContent.revision, 1);
  assert.equal(exported.structuredContent.recalculationOnOpen, true);
  assert.equal(exported.download.bytes.byteLength, 32);
  assert.notEqual(exported.download.bytes, registry.get(workbook.workbookId).sourceBytes);
});

test("clearing a chat invalidates prior workbook IDs", async () => {
  const registry = createExcelRegistry();
  const workbook = registry.add(spreadsheetWorkbook("private.xlsx", "private content"));
  registry.clear();
  await assert.rejects(
    registry.callTool("excel_understand", {
      workbookId: workbook.workbookId,
      mode: "overview",
    }),
    /unavailable in the current side-panel session/,
  );
  assert.equal(registry.totalCharacters, 0);
});

test("session character limit rejects a workbook instead of truncating it", () => {
  const registry = createExcelRegistry({ maxSessionCharacters: 20 });
  assert.throws(
    () => registry.add(spreadsheetWorkbook("too-large.xlsx", "x".repeat(21))),
    /character session limit/,
  );
});
