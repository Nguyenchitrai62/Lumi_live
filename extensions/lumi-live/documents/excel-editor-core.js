import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { unzipSync, zipSync } from "fflate";

const UTF8_DECODER = new TextDecoder("utf-8");
const UTF8_ENCODER = new TextEncoder();
const MAX_EDIT_OPERATIONS = 200;
const MAX_CELL_TEXT_CHARACTERS = 32_000;
const MAX_FORMULA_CHARACTERS = 8_192;
const BLOCKED_FORMULA_PATTERN = /(?:\b(?:WEBSERVICE|FILTERXML|RTD)\s*\(|(?:^|[=+\-])\s*(?:cmd|powershell|mshta|wscript|cscript|rundll32)(?:\.exe)?\s*\|)/i;

export class ExcelEditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExcelEditError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ExcelEditError(code, message);
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  fail("missing_source", "The original XLSX bytes are unavailable in this session.");
}

function localName(node) {
  return node?.localName || String(node?.nodeName || "").split(":").at(-1);
}

function elements(root, name) {
  return Array.from(root?.getElementsByTagName?.("*") || [])
    .filter((node) => localName(node) === name);
}

function directElements(root, name = "") {
  return Array.from(root?.childNodes || [])
    .filter((node) => node.nodeType === 1 && (!name || localName(node) === name));
}

function firstElement(root, name) {
  if (localName(root) === name) return root;
  return elements(root, name)[0] || null;
}

function attribute(node, name) {
  const exact = node?.getAttribute?.(name);
  if (exact !== null && exact !== undefined && exact !== "") return exact;
  return Array.from(node?.attributes || [])
    .find((item) => item.localName === name || item.name === name)?.value || "";
}

function parseXml(entries, partName) {
  const source = entries[partName];
  if (!source) fail("missing_part", `The XLSX archive is missing ${partName}.`);
  const document = new DOMParser().parseFromString(UTF8_DECODER.decode(source), "application/xml");
  if (!document?.documentElement || localName(document.documentElement) === "parsererror") {
    fail("invalid_xml", `The XLSX part ${partName} is malformed.`);
  }
  return document;
}

function serializeXml(document) {
  return UTF8_ENCODER.encode(new XMLSerializer().serializeToString(document));
}

function resolvePartName(sourcePart, target) {
  const cleanTarget = String(target || "").replace(/\\/g, "/");
  if (cleanTarget.startsWith("/")) return cleanTarget.slice(1);
  const segments = sourcePart.split("/");
  segments.pop();
  for (const segment of cleanTarget.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

function workbookSheetParts(entries) {
  const workbookPart = "xl/workbook.xml";
  const relationshipsPart = "xl/_rels/workbook.xml.rels";
  const workbook = parseXml(entries, workbookPart);
  const relationships = parseXml(entries, relationshipsPart);
  const relationshipTargets = new Map(elements(relationships, "Relationship").map((item) => [
    attribute(item, "Id"),
    resolvePartName(workbookPart, attribute(item, "Target")),
  ]));
  const sheets = new Map();
  for (const sheet of elements(workbook, "sheet")) {
    const name = attribute(sheet, "name");
    const relationshipId = attribute(sheet, "r:id") || attribute(sheet, "id");
    const partName = relationshipTargets.get(relationshipId);
    if (name && partName) sheets.set(name, partName);
  }
  return {
    workbook,
    workbookPart,
    relationships,
    relationshipsPart,
    sheets,
  };
}

function removeCalculationChain(entries, workbookPart, relationshipsPart, relationships) {
  const removedParts = [];
  for (const relationship of elements(relationships, "Relationship")) {
    if (!/\/calcChain$/i.test(attribute(relationship, "Type"))) continue;
    const partName = resolvePartName(workbookPart, attribute(relationship, "Target"));
    removedParts.push(partName);
    delete entries[partName];
    relationship.parentNode?.removeChild(relationship);
  }
  if (!removedParts.length) return;
  entries[relationshipsPart] = serializeXml(relationships);
  const contentTypesPart = "[Content_Types].xml";
  const contentTypes = parseXml(entries, contentTypesPart);
  const removed = new Set(removedParts);
  for (const override of elements(contentTypes, "Override")) {
    const partName = attribute(override, "PartName").replace(/^\//, "");
    if (removed.has(partName)) override.parentNode?.removeChild(override);
  }
  entries[contentTypesPart] = serializeXml(contentTypes);
}

function columnNumber(label) {
  let value = 0;
  for (const character of String(label || "").toUpperCase()) {
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  return value;
}

function columnLabel(number) {
  let value = number;
  let output = "";
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

function parseAddress(value) {
  const match = String(value || "").trim().toUpperCase().match(/^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/);
  if (!match) fail("invalid_cell", `Use one valid cell address such as B12, not "${value || ""}".`);
  const column = columnNumber(match[1]);
  const row = Number(match[2]);
  if (column > 16_384 || row > 1_048_576) {
    fail("invalid_cell", `Cell ${match[1]}${row} is outside Excel's worksheet limits.`);
  }
  return { address: `${match[1]}${row}`, column, row };
}

function parseRange(value) {
  const [startText, endText = startText] = String(value || "").replace(/\$/g, "").split(":");
  const start = parseAddress(startText);
  const end = parseAddress(endText);
  return {
    startRow: Math.min(start.row, end.row),
    endRow: Math.max(start.row, end.row),
    startColumn: Math.min(start.column, end.column),
    endColumn: Math.max(start.column, end.column),
  };
}

function rangeContains(range, cell) {
  return cell.row >= range.startRow
    && cell.row <= range.endRow
    && cell.column >= range.startColumn
    && cell.column <= range.endColumn;
}

function protectedRangeForCell(sheetDocument, cell) {
  for (const formula of elements(sheetDocument, "f")) {
    const formulaType = attribute(formula, "t");
    const reference = attribute(formula, "ref");
    if (!["array", "dataTable", "shared"].includes(formulaType) || !reference) continue;
    if (rangeContains(parseRange(reference), cell)) {
      return { formulaType, reference };
    }
  }
  return null;
}

function mergedRangeForCell(sheetDocument, cell) {
  for (const merge of elements(sheetDocument, "mergeCell")) {
    const reference = attribute(merge, "ref");
    if (!reference) continue;
    const range = parseRange(reference);
    if (!rangeContains(range, cell)) continue;
    const anchor = `${columnLabel(range.startColumn)}${range.startRow}`;
    if (cell.address !== anchor) return { reference, anchor };
  }
  return null;
}

function insertBeforeFirstGreater(parent, node, candidates, value, getValue) {
  const next = candidates.find((candidate) => getValue(candidate) > value);
  if (next) parent.insertBefore(node, next);
  else parent.appendChild(node);
}

function ensureRow(sheetDocument, rowNumber) {
  const sheetData = firstElement(sheetDocument, "sheetData");
  if (!sheetData) fail("missing_sheet_data", "The worksheet has no sheetData element.");
  const rows = directElements(sheetData, "row");
  let row = rows.find((item) => Number(attribute(item, "r")) === rowNumber);
  if (row) return row;
  row = sheetDocument.createElementNS(sheetData.namespaceURI, "row");
  row.setAttribute("r", String(rowNumber));
  insertBeforeFirstGreater(sheetData, row, rows, rowNumber, (item) => Number(attribute(item, "r")));
  return row;
}

function ensureCell(sheetDocument, cell) {
  const row = ensureRow(sheetDocument, cell.row);
  const cells = directElements(row, "c");
  let node = cells.find((item) => String(attribute(item, "r")).toUpperCase() === cell.address);
  if (node) return node;
  node = sheetDocument.createElementNS(row.namespaceURI, "c");
  node.setAttribute("r", cell.address);
  insertBeforeFirstGreater(row, node, cells, cell.column, (item) => {
    const parsed = parseAddress(attribute(item, "r"));
    return parsed.column;
  });
  return node;
}

function removeCellContent(cellNode) {
  for (const child of directElements(cellNode)) {
    if (["f", "v", "is"].includes(localName(child))) cellNode.removeChild(child);
  }
  cellNode.removeAttribute("t");
}

function appendTextValue(sheetDocument, cellNode, value) {
  const text = String(value ?? "");
  if (text.length > MAX_CELL_TEXT_CHARACTERS) {
    fail("value_limit", `A cell value may contain at most ${MAX_CELL_TEXT_CHARACTERS.toLocaleString()} characters.`);
  }
  cellNode.setAttribute("t", "inlineStr");
  const inline = sheetDocument.createElementNS(cellNode.namespaceURI, "is");
  const textNode = sheetDocument.createElementNS(cellNode.namespaceURI, "t");
  if (/^\s|\s$|\n/.test(text)) textNode.setAttribute("xml:space", "preserve");
  textNode.appendChild(sheetDocument.createTextNode(text));
  inline.appendChild(textNode);
  cellNode.appendChild(inline);
}

function appendScalarValue(sheetDocument, cellNode, value, valueType) {
  if (valueType === "string") {
    appendTextValue(sheetDocument, cellNode, value);
    return;
  }
  const scalar = sheetDocument.createElementNS(cellNode.namespaceURI, "v");
  if (valueType === "boolean") {
    const normalized = String(value).trim().toLowerCase();
    if (!["true", "false", "1", "0"].includes(normalized)) {
      fail("invalid_boolean", `Boolean value "${value}" must be true, false, 1, or 0.`);
    }
    cellNode.setAttribute("t", "b");
    scalar.appendChild(sheetDocument.createTextNode(["true", "1"].includes(normalized) ? "1" : "0"));
  } else {
    const number = Number(value);
    if (!Number.isFinite(number)) fail("invalid_number", `Value "${value}" is not a finite number.`);
    scalar.appendChild(sheetDocument.createTextNode(String(number)));
  }
  cellNode.appendChild(scalar);
}

function normalizeFormula(value) {
  const formula = String(value || "").trim().replace(/^=/, "");
  if (!formula) fail("missing_formula", "set_formula requires a non-empty formula.");
  if (formula.length > MAX_FORMULA_CHARACTERS) {
    fail("formula_limit", `A formula may contain at most ${MAX_FORMULA_CHARACTERS.toLocaleString()} characters.`);
  }
  if (BLOCKED_FORMULA_PATTERN.test(formula)) {
    fail("unsafe_formula", "This formula uses an external-data or command-style function that Lumi will not write.");
  }
  return formula;
}

function updateDimension(sheetDocument, editedCells) {
  if (!editedCells.length) return;
  const existing = firstElement(sheetDocument, "dimension");
  let bounds = null;
  try {
    if (attribute(existing, "ref")) bounds = parseRange(attribute(existing, "ref"));
  } catch {
    bounds = null;
  }
  for (const cell of editedCells) {
    bounds = bounds
      ? {
          startRow: Math.min(bounds.startRow, cell.row),
          endRow: Math.max(bounds.endRow, cell.row),
          startColumn: Math.min(bounds.startColumn, cell.column),
          endColumn: Math.max(bounds.endColumn, cell.column),
        }
      : {
          startRow: cell.row,
          endRow: cell.row,
          startColumn: cell.column,
          endColumn: cell.column,
        };
  }
  const reference = `${columnLabel(bounds.startColumn)}${bounds.startRow}:${columnLabel(bounds.endColumn)}${bounds.endRow}`;
  if (existing) existing.setAttribute("ref", reference);
  else {
    const worksheet = sheetDocument.documentElement;
    const dimension = sheetDocument.createElementNS(worksheet.namespaceURI, "dimension");
    dimension.setAttribute("ref", reference);
    worksheet.insertBefore(dimension, directElements(worksheet)[0] || null);
  }
}

function requestFullCalculation(workbookDocument) {
  const workbook = workbookDocument.documentElement;
  let calcPr = firstElement(workbookDocument, "calcPr");
  if (!calcPr) {
    calcPr = workbookDocument.createElementNS(workbook.namespaceURI, "calcPr");
    workbook.appendChild(calcPr);
  }
  calcPr.setAttribute("calcMode", "auto");
  calcPr.setAttribute("fullCalcOnLoad", "1");
  calcPr.setAttribute("forceFullCalc", "1");
}

function normalizeOperations(operations) {
  if (!Array.isArray(operations) || !operations.length) {
    fail("missing_operations", "Apply mode requires at least one edit operation.");
  }
  if (operations.length > MAX_EDIT_OPERATIONS) {
    fail("operation_limit", `One call may edit at most ${MAX_EDIT_OPERATIONS} cells.`);
  }
  const seen = new Set();
  return operations.map((operation, index) => {
    const type = String(operation?.operation || "").trim();
    if (!["set_formula", "set_value", "clear"].includes(type)) {
      fail("invalid_operation", `Edit ${index + 1} must use set_formula, set_value, or clear.`);
    }
    const sheet = String(operation.sheet || "");
    if (!sheet) fail("missing_sheet", `Edit ${index + 1} requires an exact sheet name.`);
    const cell = parseAddress(operation.cell);
    const key = `${sheet}\u0000${cell.address}`;
    if (seen.has(key)) fail("duplicate_cell", `Cell ${sheet}!${cell.address} appears more than once in this edit batch.`);
    seen.add(key);
    const valueType = String(operation.valueType || "string");
    if (type === "set_value" && !["string", "number", "boolean"].includes(valueType)) {
      fail("invalid_value_type", `Edit ${index + 1} valueType must be string, number, or boolean.`);
    }
    return {
      operation: type,
      sheet,
      cell,
      formula: type === "set_formula" ? normalizeFormula(operation.formula) : "",
      value: operation.value ?? "",
      valueType,
    };
  });
}

export function editXlsxBytes(sourceBytes, operations) {
  let entries;
  try {
    entries = unzipSync(toUint8Array(sourceBytes));
  } catch {
    fail("invalid_archive", "The original XLSX archive could not be opened for editing.");
  }
  const normalized = normalizeOperations(operations);
  const {
    workbook,
    workbookPart,
    relationships,
    relationshipsPart,
    sheets,
  } = workbookSheetParts(entries);
  const bySheet = normalized.reduce((map, operation) => {
    const items = map.get(operation.sheet) || [];
    items.push(operation);
    map.set(operation.sheet, items);
    return map;
  }, new Map());
  const applied = [];
  let formulaChanged = false;
  for (const [sheetName, sheetOperations] of bySheet) {
    const partName = sheets.get(sheetName);
    if (!partName) fail("sheet_not_found", `Sheet "${sheetName}" was not found.`);
    const sheetDocument = parseXml(entries, partName);
    const editedCells = [];
    for (const operation of sheetOperations) {
      const protectedFormula = protectedRangeForCell(sheetDocument, operation.cell);
      if (protectedFormula) {
        fail(
          "protected_formula_range",
          `${sheetName}!${operation.cell.address} belongs to ${protectedFormula.formulaType} formula range ${protectedFormula.reference}; edit the range in Excel instead.`,
        );
      }
      const merged = mergedRangeForCell(sheetDocument, operation.cell);
      if (merged) {
        fail(
          "merged_cell",
          `${sheetName}!${operation.cell.address} is inside merged range ${merged.reference}; edit its anchor ${merged.anchor} instead.`,
        );
      }
      const cellNode = ensureCell(sheetDocument, operation.cell);
      if (directElements(cellNode, "f").length) formulaChanged = true;
      removeCellContent(cellNode);
      if (operation.operation === "set_formula") {
        const formula = sheetDocument.createElementNS(cellNode.namespaceURI, "f");
        formula.appendChild(sheetDocument.createTextNode(operation.formula));
        cellNode.appendChild(formula);
        formulaChanged = true;
      } else if (operation.operation === "set_value") {
        appendScalarValue(sheetDocument, cellNode, operation.value, operation.valueType);
      }
      editedCells.push(operation.cell);
      applied.push({
        operation: operation.operation,
        sheet: sheetName,
        cell: operation.cell.address,
        ...(operation.formula ? { formula: operation.formula } : {}),
        ...(operation.operation === "set_value"
          ? { value: String(operation.value), valueType: operation.valueType }
          : {}),
      });
    }
    updateDimension(sheetDocument, editedCells);
    entries[partName] = serializeXml(sheetDocument);
  }
  requestFullCalculation(workbook);
  if (formulaChanged) {
    removeCalculationChain(entries, workbookPart, relationshipsPart, relationships);
  }
  entries[workbookPart] = serializeXml(workbook);
  let output;
  try {
    output = zipSync(entries, { level: 6 });
  } catch {
    fail("export_failed", "The edited XLSX archive could not be created.");
  }
  return { bytes: output, applied };
}
