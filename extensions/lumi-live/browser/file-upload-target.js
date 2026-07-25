export const FILE_UPLOAD_TARGET_ATTRIBUTE = "data-lumi-file-upload-target";

const MIME_TYPES_BY_EXTENSION = new Map([
  [".csv", ["text/csv"]],
  [".doc", ["application/msword"]],
  [".docx", ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]],
  [".dwg", ["application/acad", "application/x-acad", "application/autocad_dwg", "image/vnd.dwg"]],
  [".gif", ["image/gif"]],
  [".jpeg", ["image/jpeg"]],
  [".jpg", ["image/jpeg"]],
  [".json", ["application/json"]],
  [".pdf", ["application/pdf"]],
  [".png", ["image/png"]],
  [".txt", ["text/plain"]],
  [".xls", ["application/vnd.ms-excel"]],
  [".xlsx", ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]],
  [".zip", ["application/zip"]],
]);

function fileExtension(fileName) {
  const name = String(fileName || "").trim().toLowerCase();
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > -1 ? name.slice(dotIndex) : "";
}

function acceptTokenMatchesFile(token, fileName) {
  const normalizedToken = String(token || "").trim().toLowerCase();
  if (!normalizedToken) return false;
  const extension = fileExtension(fileName);
  if (normalizedToken.startsWith(".")) return normalizedToken === extension;

  const mimeTypes = MIME_TYPES_BY_EXTENSION.get(extension) || [];
  if (normalizedToken.endsWith("/*")) {
    const prefix = normalizedToken.slice(0, -1);
    return mimeTypes.some((mimeType) => mimeType.startsWith(prefix));
  }
  return mimeTypes.includes(normalizedToken);
}

function inputAcceptsFiles(input, fileNames) {
  const accept = String(input.getAttribute?.("accept") || "").trim();
  if (!accept) return { accepted: true, explicit: false };
  const tokens = accept.split(",").map((token) => token.trim()).filter(Boolean);
  return {
    accepted: fileNames.every((fileName) => (
      tokens.some((token) => acceptTokenMatchesFile(token, fileName))
    )),
    explicit: true,
  };
}

function uploadControlRelationshipScore(input, indexedElement) {
  if (!indexedElement) return 0;
  if (indexedElement === input) return 1000;
  if (indexedElement.contains?.(input) || input.contains?.(indexedElement)) return 1000;

  const indexedLabel = indexedElement.closest?.("label");
  if (indexedLabel?.contains?.(input)) return 1000;
  const inputLabel = input.closest?.("label");
  if (inputLabel?.contains?.(indexedElement)) return 1000;

  const targetId = indexedElement.getAttribute?.("for");
  if (targetId && input.id && targetId === input.id) return 1000;

  const controlledId = indexedElement.getAttribute?.("aria-controls");
  const controlledElement = controlledId
    ? indexedElement.ownerDocument?.getElementById?.(controlledId)
    : null;
  if (controlledElement?.contains?.(input)) return 950;

  const indexedAncestors = new Map();
  let indexedAncestor = indexedElement.parentElement;
  for (let depth = 1; indexedAncestor && depth <= 6; depth += 1) {
    const tagName = String(indexedAncestor.tagName || "").toUpperCase();
    if (tagName !== "BODY" && tagName !== "HTML") indexedAncestors.set(indexedAncestor, depth);
    indexedAncestor = indexedAncestor.parentElement;
  }
  let inputAncestor = input.parentElement;
  for (let depth = 1; inputAncestor && depth <= 6; depth += 1) {
    const indexedDepth = indexedAncestors.get(inputAncestor);
    if (indexedDepth) return Math.max(300, 760 - (indexedDepth + depth) * 45);
    inputAncestor = inputAncestor.parentElement;
  }
  return 0;
}

function isVisibleElement(element) {
  if (!element?.getClientRects) return false;
  return element.getClientRects().length > 0;
}

export function chooseCompatibleFileInput(inputs, fileNames, indexedElement = null) {
  const normalizedNames = Array.from(fileNames || [])
    .map((fileName) => String(fileName || "").trim())
    .filter(Boolean);
  if (!normalizedNames.length) throw new Error("At least one local file name is required.");

  const candidates = [];
  let order = 0;
  for (const input of inputs || []) {
    const currentOrder = order;
    order += 1;
    if (!input || String(input.type || input.getAttribute?.("type") || "").toLowerCase() !== "file") {
      continue;
    }
    if (input.disabled || input.hasAttribute?.("disabled")) continue;
    if (input.webkitdirectory || input.hasAttribute?.("webkitdirectory")) continue;
    if (normalizedNames.length > 1 && !input.multiple && !input.hasAttribute?.("multiple")) continue;

    const acceptance = inputAcceptsFiles(input, normalizedNames);
    if (!acceptance.accepted) continue;
    let score = acceptance.explicit ? 100 : 10;
    const relationshipScore = uploadControlRelationshipScore(input, indexedElement);
    score += relationshipScore;
    if (isVisibleElement(input)) score += 1;
    candidates.push({
      input,
      score,
      order: currentOrder,
      explicitAccept: acceptance.explicit,
      relationshipScore,
    });
  }

  candidates.sort((left, right) => right.score - left.score || left.order - right.order);
  const best = candidates[0];
  if (!best) {
    return {
      input: null,
      candidateCount: 0,
      strategy: "no_compatible_existing_input",
    };
  }
  if (candidates.length > 1 && best.relationshipScore === 0) {
    return {
      input: null,
      candidateCount: candidates.length,
      strategy: "ambiguous_compatible_inputs",
    };
  }
  return {
    input: best.input,
    candidateCount: candidates.length,
    strategy: best.score >= 1000
      ? "indexed_file_control"
      : best.score >= 300
        ? "upload_control_container"
        : best.explicitAccept ? "matching_accept_attribute" : "first_generic_file_input",
  };
}
