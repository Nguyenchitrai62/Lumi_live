import { DOMParser } from "@xmldom/xmldom";
import { unzipSync } from "fflate";

export const DOCUMENT_LIMITS = Object.freeze({
  maxFileBytes: 25 * 1024 * 1024,
  maxBatchBytes: 50 * 1024 * 1024,
  maxArchiveBytes: 100 * 1024 * 1024,
  maxWorkbookCells: 250_000,
  maxDocumentCharacters: 2_000_000,
  maxSessionCharacters: 5_000_000,
});

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const MAX_ZIP_ENTRIES = 20_000;
const UTF8_DECODER = new TextDecoder("utf-8");
const XML_ENCODER = new TextEncoder();

export class DocumentParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DocumentParseError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new DocumentParseError(code, message);
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  fail("invalid_input", "The document bytes are unavailable.");
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function resolvePartPath(basePart, target) {
  const normalizedTarget = normalizePath(target);
  if (!normalizedTarget) return "";
  if (String(target).startsWith("/")) return normalizedTarget;
  const segments = `${normalizePath(basePart).replace(/[^/]+$/, "")}${normalizedTarget}`.split("/");
  const resolved = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return resolved.join("/");
}

function readZipCentralDirectory(bytes, limits) {
  if (bytes.byteLength < 22) fail("invalid_archive", "This OOXML file is not a valid ZIP archive.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocdOffset = -1;
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) fail("invalid_archive", "The ZIP end-of-directory record is missing.");
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (diskNumber || centralDisk || entryCount === 0xffff) {
    fail("unsupported_archive", "Multi-volume and ZIP64 OOXML files are not supported.");
  }
  if (entryCount > MAX_ZIP_ENTRIES) {
    fail("archive_limit", `This archive contains more than ${MAX_ZIP_ENTRIES.toLocaleString()} entries.`);
  }
  if (centralOffset + centralSize > bytes.byteLength) {
    fail("invalid_archive", "The ZIP central directory points outside the file.");
  }
  let offset = centralOffset;
  let uncompressedBytes = 0;
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
      fail("invalid_archive", "The ZIP central directory is malformed.");
    }
    const flags = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const nextOffset = nameStart + nameLength + extraLength + commentLength;
    if (nextOffset > bytes.byteLength) fail("invalid_archive", "A ZIP entry is truncated.");
    const name = UTF8_DECODER.decode(bytes.subarray(nameStart, nameStart + nameLength));
    if (flags & 1) fail("encrypted_archive", "Encrypted or password-protected documents are not supported.");
    if (
      name.startsWith("/")
      || name.startsWith("\\")
      || /^[a-zA-Z]:/.test(name)
      || normalizePath(name).split("/").includes("..")
    ) {
      fail("unsafe_archive", "The document archive contains an unsafe file path.");
    }
    uncompressedBytes += uncompressedSize;
    if (uncompressedBytes > limits.maxArchiveBytes) {
      fail(
        "archive_limit",
        `The document expands beyond the ${Math.round(limits.maxArchiveBytes / 1048576)} MB safety limit.`,
      );
    }
    if (compressedSize && uncompressedSize / compressedSize > 10_000) {
      fail("archive_bomb", "The document has an unsafe archive compression ratio.");
    }
    entries.push({ name: normalizePath(name), compressedSize, uncompressedSize });
    offset = nextOffset;
  }
  return { entries, uncompressedBytes };
}

function unzipOoxml(bytes, limits) {
  readZipCentralDirectory(bytes, limits);
  let unzipped;
  try {
    unzipped = unzipSync(bytes);
  } catch {
    fail("invalid_archive", "The OOXML ZIP archive is damaged or unsupported.");
  }
  const parts = new Map();
  let actualBytes = 0;
  for (const [name, content] of Object.entries(unzipped)) {
    actualBytes += content.byteLength;
    if (actualBytes > limits.maxArchiveBytes) {
      fail("archive_limit", "The expanded archive exceeds the configured safety limit.");
    }
    parts.set(normalizePath(name), content);
  }
  return parts;
}

function xmlPart(parts, name, { required = false } = {}) {
  const bytes = parts.get(normalizePath(name));
  if (!bytes) {
    if (required) fail("missing_part", `The OOXML part ${name} is missing.`);
    return null;
  }
  const errors = [];
  const source = UTF8_DECODER.decode(bytes);
  let document;
  try {
    document = new DOMParser({
      onError: (level, message) => {
        if (level !== "warning") errors.push(String(message));
      },
    }).parseFromString(source, "application/xml");
  } catch {
    fail("invalid_xml", `The OOXML part ${name} contains malformed XML.`);
  }
  if (!document?.documentElement || errors.length) {
    fail("invalid_xml", `The OOXML part ${name} contains malformed XML.`);
  }
  return document;
}

function elementsByLocalName(root, name) {
  if (!root?.getElementsByTagName) return [];
  const matches = root.getElementsByTagName(name);
  const namespaced = root.getElementsByTagName(`w:${name}`);
  const spreadsheet = root.getElementsByTagName(`x:${name}`);
  const all = [...matches, ...namespaced, ...spreadsheet];
  if (all.length) return [...new Set(all)];
  return Array.from(root.getElementsByTagName("*")).filter(
    (element) => element.localName === name || element.nodeName?.split(":").at(-1) === name,
  );
}

function firstElement(root, name) {
  return elementsByLocalName(root, name)[0] || null;
}

function attribute(element, name, fallback = "") {
  if (!element?.getAttribute) return fallback;
  return element.getAttribute(name)
    ?? element.getAttribute(`r:${name}`)
    ?? element.getAttribute(`w:${name}`)
    ?? fallback;
}

function relationshipMap(parts, sourcePart) {
  const normalized = normalizePath(sourcePart);
  const slash = normalized.lastIndexOf("/");
  const directory = slash >= 0 ? normalized.slice(0, slash + 1) : "";
  const filename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const relPath = `${directory}_rels/${filename}.rels`;
  const document = xmlPart(parts, relPath);
  const relationships = new Map();
  for (const rel of elementsByLocalName(document, "Relationship")) {
    relationships.set(attribute(rel, "Id"), {
      id: attribute(rel, "Id"),
      type: attribute(rel, "Type"),
      targetMode: attribute(rel, "TargetMode"),
      target: attribute(rel, "Target"),
      part: resolvePartPath(sourcePart, attribute(rel, "Target")),
    });
  }
  return relationships;
}

function textFromRuns(root) {
  const output = [];
  const walk = (node) => {
    for (const child of Array.from(node?.childNodes || [])) {
      const localName = child.localName || child.nodeName?.split(":").at(-1);
      if (localName === "t" || localName === "instrText" || localName === "delText") {
        output.push(child.textContent || "");
      } else if (localName === "tab") {
        output.push("\t");
      } else if (localName === "br" || localName === "cr") {
        output.push("\n");
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  return output.join("");
}

function enforceCharacterLimit(text, limits) {
  if (text.length > limits.maxDocumentCharacters) {
    fail(
      "character_limit",
      `The extracted document contains more than ${limits.maxDocumentCharacters.toLocaleString()} characters.`,
    );
  }
}

function columnNumber(label) {
  let value = 0;
  for (const character of String(label || "").toUpperCase()) {
    if (character < "A" || character > "Z") return 0;
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  return value;
}

export function columnLabel(number) {
  let value = Math.max(1, Math.trunc(Number(number) || 1));
  let output = "";
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

export function parseCellAddress(address) {
  const match = String(address || "").toUpperCase().match(/^\$?([A-Z]+)\$?(\d+)$/);
  if (!match) return null;
  return {
    address: `${match[1]}${Number(match[2])}`,
    column: columnNumber(match[1]),
    row: Number(match[2]),
  };
}

function builtInNumberFormat(id) {
  if ([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57].includes(id)) return "date";
  if ([9, 10].includes(id)) return "percent";
  if ([5, 6, 7, 8, 37, 38, 39, 40, 41, 42, 43, 44].includes(id)) return "currency";
  return "";
}

function classifyNumberFormat(formatCode, id) {
  const code = String(formatCode || "");
  const stripped = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "").toLowerCase();
  if (/[ymdhis]/.test(stripped)) return "date";
  if (stripped.includes("%")) return "percent";
  if (/[$€£¥₫]|vnd|usd|eur/.test(code.toLowerCase())) return "currency";
  return builtInNumberFormat(id);
}

function parseStyles(parts) {
  const document = xmlPart(parts, "xl/styles.xml");
  if (!document) return [];
  const custom = new Map();
  for (const format of elementsByLocalName(document, "numFmt")) {
    custom.set(Number(attribute(format, "numFmtId")), attribute(format, "formatCode"));
  }
  const cellXfs = elementsByLocalName(document, "cellXfs")[0];
  if (!cellXfs) return [];
  return Array.from(cellXfs.childNodes || [])
    .filter((node) => (node.localName || node.nodeName?.split(":").at(-1)) === "xf")
    .map((xf) => {
      const numFmtId = Number(attribute(xf, "numFmtId"));
      const numberFormat = custom.get(numFmtId) || "";
      return {
        numFmtId,
        numberFormat,
        numberFormatKind: classifyNumberFormat(numberFormat, numFmtId),
      };
    });
}

function parseSharedStrings(parts) {
  const document = xmlPart(parts, "xl/sharedStrings.xml");
  if (!document) return [];
  return elementsByLocalName(document, "si").map((item) => textFromRuns(item));
}

function parseSpreadsheetComments(parts, sheetPart, relationships) {
  const commentRel = [...relationships.values()].find((rel) => /\/comments$/.test(rel.type));
  if (!commentRel || commentRel.targetMode === "External") return new Map();
  const document = xmlPart(parts, commentRel.part);
  const comments = new Map();
  for (const comment of elementsByLocalName(document, "comment")) {
    comments.set(attribute(comment, "ref"), textFromRuns(comment).trim());
  }
  return comments;
}

function excelDateDisplay(serial, date1904) {
  const value = Number(serial);
  if (!Number.isFinite(value)) return String(serial);
  const epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31);
  const adjustedValue = !date1904 && value >= 60 ? value - 1 : value;
  const date = new Date(epoch + adjustedValue * 86_400_000);
  if (!Number.isFinite(date.getTime())) return String(serial);
  const iso = date.toISOString();
  return Math.abs(value - Math.trunc(value)) < Number.EPSILON
    ? iso.slice(0, 10)
    : iso.slice(0, 19).replace("T", " ");
}

function spreadsheetCellValue(cell, sharedStrings, styles, date1904 = false) {
  const type = attribute(cell, "t");
  const styleIndex = Number(attribute(cell, "s", "-1"));
  const style = Number.isInteger(styleIndex) && styleIndex >= 0 ? styles[styleIndex] || null : null;
  const formulaElement = firstElement(cell, "f");
  const formulaType = attribute(formulaElement, "t", formulaElement ? "normal" : "");
  const formulaReference = attribute(formulaElement, "ref");
  const sharedFormulaIndex = attribute(formulaElement, "si");
  const formulaText = formulaElement?.textContent || "";
  const formula = formulaElement
    ? formulaText || `[${formulaType || "shared"} formula${sharedFormulaIndex ? ` si=${sharedFormulaIndex}` : ""}]`
    : "";
  const rawValue = firstElement(cell, "v")?.textContent ?? "";
  let value = rawValue;
  if (type === "s") value = sharedStrings[Number(rawValue)] ?? rawValue;
  else if (type === "inlineStr") value = textFromRuns(firstElement(cell, "is") || cell);
  else if (type === "b") value = rawValue === "1" ? "TRUE" : "FALSE";
  else if (type === "e") value = rawValue || "#ERROR";
  else if (type === "d") value = rawValue;
  else if (!type && rawValue !== "" && Number.isFinite(Number(rawValue))) {
    if (style?.numberFormatKind === "percent") value = `${Number(rawValue) * 100}%`;
    else if (style?.numberFormatKind === "date") value = excelDateDisplay(rawValue, date1904);
    else value = rawValue;
  }
  return {
    type: type || (rawValue === "" ? "blank" : "number"),
    value: String(value),
    rawValue: String(rawValue),
    formula: String(formula),
    cachedResult: formulaElement ? String(rawValue) : "",
    formulaType,
    formulaReference,
    sharedFormulaIndex,
    style,
  };
}

function drawingMetadata(parts, sheetPart, relationships) {
  let charts = 0;
  let images = 0;
  for (const rel of relationships.values()) {
    if (!/\/drawing$/.test(rel.type) || rel.targetMode === "External") continue;
    const drawingRelationships = relationshipMap(parts, rel.part);
    for (const drawingRel of drawingRelationships.values()) {
      if (/\/chart$/.test(drawingRel.type)) charts += 1;
      if (/\/image$/.test(drawingRel.type)) images += 1;
    }
  }
  return { charts, images };
}

function parseWorksheet(parts, sheet, sharedStrings, styles, cellCounter, limits, date1904) {
  const document = xmlPart(parts, sheet.part, { required: true });
  const relationships = relationshipMap(parts, sheet.part);
  const comments = parseSpreadsheetComments(parts, sheet.part, relationships);
  const hyperlinkByAddress = new Map();
  for (const hyperlink of elementsByLocalName(document, "hyperlink")) {
    const reference = attribute(hyperlink, "ref");
    const rel = relationships.get(attribute(hyperlink, "id"));
    hyperlinkByAddress.set(reference, {
      target: rel?.targetMode === "External" ? rel.target : rel?.part || "",
      location: attribute(hyperlink, "location"),
      display: attribute(hyperlink, "display"),
    });
  }
  const cells = [];
  let minRow = Infinity;
  let minColumn = Infinity;
  let maxRow = 0;
  let maxColumn = 0;
  for (const cellElement of elementsByLocalName(document, "c")) {
    const address = parseCellAddress(attribute(cellElement, "r"));
    if (!address) continue;
    const parsed = spreadsheetCellValue(cellElement, sharedStrings, styles, date1904);
    const comment = comments.get(address.address) || "";
    const hyperlink = hyperlinkByAddress.get(address.address) || null;
    if (!parsed.value && !parsed.formula && !comment && !hyperlink) continue;
    cellCounter.count += 1;
    if (cellCounter.count > limits.maxWorkbookCells) {
      fail(
        "cell_limit",
        `The workbook contains more than ${limits.maxWorkbookCells.toLocaleString()} populated cells.`,
      );
    }
    cells.push({ ...address, ...parsed, comment, hyperlink });
    minRow = Math.min(minRow, address.row);
    minColumn = Math.min(minColumn, address.column);
    maxRow = Math.max(maxRow, address.row);
    maxColumn = Math.max(maxColumn, address.column);
  }
  const dimension = attribute(firstElement(document, "dimension"), "ref");
  const derivedRange = cells.length
    ? `${columnLabel(minColumn)}${minRow}:${columnLabel(maxColumn)}${maxRow}`
    : "";
  const merges = elementsByLocalName(document, "mergeCell")
    .map((merge) => attribute(merge, "ref"))
    .filter(Boolean);
  const media = drawingMetadata(parts, sheet.part, relationships);
  return {
    name: sheet.name,
    state: sheet.state,
    index: sheet.index,
    usedRange: dimension || derivedRange,
    populatedCellCount: cells.length,
    rowCount: cells.length ? maxRow : 0,
    columnCount: cells.length ? maxColumn : 0,
    cells,
    merges,
    commentCount: comments.size,
    hyperlinkCount: hyperlinkByAddress.size,
    charts: media.charts,
    images: media.images,
  };
}

function formatSpreadsheetContent(workbook) {
  const lines = [
    `[Workbook] ${workbook.name}`,
    `[Sheets] ${workbook.sheets.length}; defined names: ${workbook.definedNames.length}`,
  ];
  for (const sheet of workbook.sheets) {
    lines.push(
      "",
      `[Sheet] ${sheet.name} | state=${sheet.state} | usedRange=${sheet.usedRange || "(empty)"} | populatedCells=${sheet.populatedCellCount}`,
    );
    if (sheet.merges.length) lines.push(`[Merges] ${sheet.merges.join(", ")}`);
    if (sheet.charts || sheet.images) {
      lines.push(`[Embedded media] charts=${sheet.charts}; images=${sheet.images}`);
    }
    for (const cell of sheet.cells) {
      const annotations = [];
      if (cell.formula) annotations.push(`formula=${cell.formula}`, `cached=${cell.cachedResult}`);
      if (cell.style?.numberFormat) annotations.push(`format=${cell.style.numberFormat}`);
      if (cell.hyperlink) annotations.push(`hyperlink=${cell.hyperlink.target || cell.hyperlink.location}`);
      if (cell.comment) annotations.push(`comment=${cell.comment.replace(/\s+/g, " ")}`);
      lines.push(`${cell.address}\t${cell.value}${annotations.length ? `\t[${annotations.join("; ")}]` : ""}`);
    }
  }
  if (workbook.definedNames.length) {
    lines.push("", "[Defined names]");
    for (const name of workbook.definedNames) {
      lines.push(`${name.name}\t${name.reference}${name.localSheetId !== "" ? `\tlocalSheetId=${name.localSheetId}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function parseXlsx(bytesInput, {
  name = "workbook.xlsx",
  mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  limits = DOCUMENT_LIMITS,
} = {}) {
  const bytes = toUint8Array(bytesInput);
  if (bytes.byteLength < 4) fail("empty_file", "The XLSX file is empty or truncated.");
  if (bytes.byteLength > limits.maxFileBytes) fail("file_limit", "This file exceeds the 25 MB limit.");
  if (new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== ZIP_LOCAL_SIGNATURE) {
    fail("signature_mismatch", "The file does not have a valid XLSX ZIP signature.");
  }
  const parts = unzipOoxml(bytes, limits);
  const workbookDocument = xmlPart(parts, "xl/workbook.xml", { required: true });
  const workbookRelationships = relationshipMap(parts, "xl/workbook.xml");
  const contentTypes = UTF8_DECODER.decode(parts.get("[Content_Types].xml") || XML_ENCODER.encode(""));
  if (!/spreadsheetml\.sheet\.main\+xml/i.test(contentTypes)) {
    fail("signature_mismatch", "The archive is not an XLSX workbook.");
  }
  const sharedStrings = parseSharedStrings(parts);
  const styles = parseStyles(parts);
  const date1904 = ["1", "true"].includes(
    attribute(firstElement(workbookDocument, "workbookPr"), "date1904").toLowerCase(),
  );
  const sheetDefinitions = elementsByLocalName(workbookDocument, "sheet").map((sheet, index) => {
    const relationship = workbookRelationships.get(attribute(sheet, "id"));
    if (!relationship || relationship.targetMode === "External") {
      fail("missing_part", `The worksheet relationship for ${attribute(sheet, "name")} is invalid.`);
    }
    return {
      name: attribute(sheet, "name") || `Sheet${index + 1}`,
      state: attribute(sheet, "state", "visible"),
      index,
      part: relationship.part,
    };
  });
  const cellCounter = { count: 0 };
  const sheets = sheetDefinitions.map((sheet) =>
    parseWorksheet(parts, sheet, sharedStrings, styles, cellCounter, limits, date1904));
  const definedNames = elementsByLocalName(workbookDocument, "definedName").map((item) => ({
    name: attribute(item, "name"),
    localSheetId: attribute(item, "localSheetId"),
    hidden: attribute(item, "hidden") === "1",
    reference: String(item.textContent || "").trim(),
  }));
  const workbook = {
    kind: "xlsx",
    name,
    mimeType,
    byteSize: bytes.byteLength,
    structure: {
      sheetCount: sheets.length,
      populatedCellCount: cellCounter.count,
      sheets: sheets.map((sheet) => ({
        name: sheet.name,
        state: sheet.state,
        usedRange: sheet.usedRange,
        populatedCellCount: sheet.populatedCellCount,
        rowCount: sheet.rowCount,
        columnCount: sheet.columnCount,
        mergeCount: sheet.merges.length,
        hyperlinkCount: sheet.hyperlinkCount,
        commentCount: sheet.commentCount,
        chartCount: sheet.charts,
        imageCount: sheet.images,
      })),
      definedNames,
      dateSystem: date1904 ? "1904" : "1900",
    },
    sheets,
    definedNames,
  };
  const normalizedText = formatSpreadsheetContent(workbook);
  enforceCharacterLimit(normalizedText, limits);
  return { ...workbook, normalizedText, characterCount: normalizedText.length };
}

function decodeCsv(bytes) {
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  const start = bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? 3
    : 0;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start));
  } catch {
    try {
      return new TextDecoder("windows-1258").decode(bytes);
    } catch {
      fail("encoding", "The CSV encoding is not valid UTF-8 or Windows-1258.");
    }
  }
}

function parseCsvWithDelimiter(text, delimiter, { strict = true } = {}) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === "\"" && text[index + 1] === "\"") {
        field += "\"";
        index += 1;
      } else if (character === "\"") {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === "\"" && field === "") {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = "";
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted && strict) fail("invalid_csv", "The CSV ends inside a quoted field.");
  if (field !== "" || row.length || !rows.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length > 1 && rows.at(-1).length === 1 && rows.at(-1)[0] === "") rows.pop();
  return rows;
}

function detectDelimiter(text) {
  const candidates = [",", ";", "\t"];
  const sample = text.slice(0, 64_000);
  let best = { delimiter: ",", score: -Infinity };
  for (const delimiter of candidates) {
    let rows;
    try {
      rows = parseCsvWithDelimiter(sample, delimiter, { strict: false }).slice(0, 30);
    } catch {
      continue;
    }
    const widths = rows.map((row) => row.length);
    const max = Math.max(...widths, 1);
    const consistent = widths.filter((width) => width === max).length;
    const score = max > 1 ? max * 10 + consistent : 0;
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

export function parseCsv(bytesInput, {
  name = "data.csv",
  mimeType = "text/csv",
  limits = DOCUMENT_LIMITS,
} = {}) {
  const bytes = toUint8Array(bytesInput);
  if (!bytes.byteLength) fail("empty_file", "The CSV file is empty.");
  if (bytes.byteLength > limits.maxFileBytes) fail("file_limit", "This file exceeds the 25 MB limit.");
  if (
    bytes.byteLength >= 4
    && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === ZIP_LOCAL_SIGNATURE
  ) {
    fail("signature_mismatch", "This ZIP or OOXML file was renamed to .csv.");
  }
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8_192));
  const utf16Le = bytes[0] === 0xff && bytes[1] === 0xfe;
  if (!utf16Le && sample.filter((byte) => byte === 0).length > Math.max(8, sample.length * 0.02)) {
    fail("signature_mismatch", "This file appears to be binary data, not CSV text.");
  }
  const text = decodeCsv(bytes).replace(/^\uFEFF/, "");
  enforceCharacterLimit(text, limits);
  const delimiter = detectDelimiter(text);
  const rows = parseCsvWithDelimiter(text, delimiter);
  const populatedCells = [];
  let maxColumns = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    maxColumns = Math.max(maxColumns, rows[rowIndex].length);
    for (let columnIndex = 0; columnIndex < rows[rowIndex].length; columnIndex += 1) {
      const value = rows[rowIndex][columnIndex];
      if (value === "") continue;
      populatedCells.push({
        address: `${columnLabel(columnIndex + 1)}${rowIndex + 1}`,
        row: rowIndex + 1,
        column: columnIndex + 1,
        type: "string",
        value,
        rawValue: value,
        formula: "",
        cachedResult: "",
        style: null,
        comment: "",
        hyperlink: null,
      });
      if (populatedCells.length > limits.maxWorkbookCells) {
        fail("cell_limit", `The CSV contains more than ${limits.maxWorkbookCells.toLocaleString()} populated cells.`);
      }
    }
  }
  const sheet = {
    name: "CSV",
    state: "visible",
    index: 0,
    usedRange: rows.length && maxColumns ? `A1:${columnLabel(maxColumns)}${rows.length}` : "",
    populatedCellCount: populatedCells.length,
    rowCount: rows.length,
    columnCount: maxColumns,
    cells: populatedCells,
    merges: [],
    commentCount: 0,
    hyperlinkCount: 0,
    charts: 0,
    images: 0,
  };
  const workbook = {
    kind: "csv",
    name,
    mimeType,
    byteSize: bytes.byteLength,
    delimiter: delimiter === "\t" ? "tab" : delimiter,
    sheets: [sheet],
    definedNames: [],
    structure: {
      sheetCount: 1,
      populatedCellCount: populatedCells.length,
      delimiter: delimiter === "\t" ? "tab" : delimiter,
      sheets: [{
        name: "CSV",
        state: "visible",
        usedRange: sheet.usedRange,
        populatedCellCount: populatedCells.length,
        rowCount: rows.length,
        columnCount: maxColumns,
        mergeCount: 0,
        hyperlinkCount: 0,
        commentCount: 0,
        chartCount: 0,
        imageCount: 0,
      }],
      definedNames: [],
    },
  };
  const normalizedText = formatSpreadsheetContent(workbook);
  enforceCharacterLimit(normalizedText, limits);
  return { ...workbook, normalizedText, characterCount: normalizedText.length };
}

export function sniffDocumentKind(bytesInput, name = "", mimeType = "") {
  const bytes = toUint8Array(bytesInput);
  const extension = String(name).toLowerCase().match(/\.([^.]+)$/)?.[1] || "";
  const mime = String(mimeType || "").toLowerCase();
  if (extension === "csv" || mime === "text/csv" || mime === "application/csv") {
    if (bytes.byteLength >= 4) {
      const signature = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
      if (signature === ZIP_LOCAL_SIGNATURE) fail("signature_mismatch", "This ZIP file was renamed to .csv.");
    }
    return "csv";
  }
  if (bytes.byteLength < 4) fail("empty_file", "The document is empty or truncated.");
  const signature = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (signature !== ZIP_LOCAL_SIGNATURE) {
    fail("signature_mismatch", "The OOXML file does not have a ZIP signature.");
  }
  const parts = unzipOoxml(bytes, DOCUMENT_LIMITS);
  const contentTypes = UTF8_DECODER.decode(parts.get("[Content_Types].xml") || XML_ENCODER.encode(""));
  if (/spreadsheetml\.sheet\.main\+xml/i.test(contentTypes)) return "xlsx";
  fail("signature_mismatch", "This archive is not an XLSX workbook.");
}

export function parseDocumentBytes(bytesInput, options = {}) {
  const kind = options.kind || sniffDocumentKind(bytesInput, options.name, options.mimeType);
  if (kind === "xlsx") return parseXlsx(bytesInput, options);
  if (kind === "csv") return parseCsv(bytesInput, options);
  fail("unsupported_type", "Excel Understand supports XLSX and CSV files only.");
}
