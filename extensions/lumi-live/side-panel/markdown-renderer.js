function splitTableRow(line) {
  let value = String(line || "").trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value.split("|").map((cell) => cell.trim());
}

function isTableDivider(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isHorizontalRule(line) {
  return /^(?:\s*)([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function isListItem(line) {
  return /^\s*(?:[-+*]|\d+\.)\s+/.test(line);
}

function startsBlock(lines, index) {
  const line = lines[index] || "";
  return /^```/.test(line)
    || /^#{1,6}\s+/.test(line)
    || /^\s*>\s?/.test(line)
    || isListItem(line)
    || isHorizontalRule(line)
    || (
      line.includes("|")
      && index + 1 < lines.length
      && isTableDivider(lines[index + 1])
    );
}

export function parseMarkdownBlocks(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: fence[1] || "", text: codeLines.join("\n") });
      continue;
    }

    if (
      line.includes("|")
      && index + 1 < lines.length
      && isTableDivider(lines[index + 1])
    ) {
      const headers = splitTableRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: quoteLines.join("\n") });
      continue;
    }

    if (isListItem(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-+*]\s+/;
      while (index < lines.length && pattern.test(lines[index])) {
        items.push(lines[index].replace(pattern, "").trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (isHorizontalRule(line)) {
      blocks.push({ type: "separator" });
      index += 1;
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (
      index < lines.length
      && lines[index].trim()
      && !startsBlock(lines, index)
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }

  return blocks;
}

export function isSafeMarkdownUrl(rawUrl, { image = false } = {}) {
  const value = String(rawUrl || "").trim();
  if (image && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value)) {
    return true;
  }
  try {
    const url = new URL(value);
    return image
      ? ["http:", "https:"].includes(url.protocol)
      : ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function appendPlainText(container, text) {
  const value = String(text || "");
  const urlPattern = /https?:\/\/[^\s<]+/gi;
  let cursor = 0;
  for (const match of value.matchAll(urlPattern)) {
    if (match.index > cursor) container.append(document.createTextNode(value.slice(cursor, match.index)));
    const trailing = match[0].match(/[.,;:!?\])]+$/)?.[0] || "";
    const href = trailing ? match[0].slice(0, -trailing.length) : match[0];
    if (isSafeMarkdownUrl(href)) {
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      link.textContent = href;
      container.append(link);
      if (trailing) container.append(document.createTextNode(trailing));
    } else {
      container.append(document.createTextNode(match[0]));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) container.append(document.createTextNode(value.slice(cursor)));
}

function renderInline(container, text) {
  const value = String(text || "");
  const pattern = /(!?\[([^\]]*)\]\(([^)\s]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  let cursor = 0;

  for (const match of value.matchAll(pattern)) {
    if (match.index > cursor) appendPlainText(container, value.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("![")) {
      if (isSafeMarkdownUrl(match[3], { image: true })) {
        const image = document.createElement("img");
        image.className = "markdown-image";
        image.src = match[3];
        image.alt = match[2] || "Conversation image";
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        container.append(image);
      } else {
        container.append(document.createTextNode(token));
      }
    } else if (token.startsWith("[")) {
      if (isSafeMarkdownUrl(match[3])) {
        const link = document.createElement("a");
        link.href = match[3];
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        link.textContent = match[2] || match[3];
        container.append(link);
      } else {
        container.append(document.createTextNode(token));
      }
    } else if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = match[4];
      container.append(code);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      const strong = document.createElement("strong");
      strong.textContent = match[5] || match[6];
      container.append(strong);
    } else {
      const emphasis = document.createElement("em");
      emphasis.textContent = match[7] || match[8];
      container.append(emphasis);
    }
    cursor = match.index + token.length;
  }
  if (cursor < value.length) appendPlainText(container, value.slice(cursor));
}

function renderTable(block) {
  const wrapper = document.createElement("div");
  wrapper.className = "markdown-table-scroll";
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headingRow = document.createElement("tr");
  for (const header of block.headers) {
    const cell = document.createElement("th");
    renderInline(cell, header);
    headingRow.append(cell);
  }
  head.append(headingRow);
  table.append(head);

  const body = document.createElement("tbody");
  for (const row of block.rows) {
    const tableRow = document.createElement("tr");
    for (let index = 0; index < block.headers.length; index += 1) {
      const cell = document.createElement("td");
      renderInline(cell, row[index] || "");
      tableRow.append(cell);
    }
    body.append(tableRow);
  }
  table.append(body);
  wrapper.append(table);
  return wrapper;
}

function syncAttributes(current, next) {
  for (const attribute of Array.from(current.attributes)) {
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of Array.from(next.attributes)) {
    if (current.getAttribute(attribute.name) !== attribute.value) {
      current.setAttribute(attribute.name, attribute.value);
    }
  }
}

function reconcileNode(current, next) {
  if (
    current.nodeType !== next.nodeType
    || (current.nodeType === 1 && current.tagName !== next.tagName)
  ) {
    current.replaceWith(next);
    return;
  }
  if (current.nodeType === 3) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  if (current.nodeType === 1) {
    syncAttributes(current, next);
    reconcileChildren(current, next);
    return;
  }
  if (!current.isEqualNode(next)) current.replaceWith(next);
}

function reconcileChildren(current, next) {
  const nextChildren = Array.from(next.childNodes);
  let index = 0;
  while (index < nextChildren.length || index < current.childNodes.length) {
    const currentChild = current.childNodes[index];
    const nextChild = nextChildren[index];
    if (!nextChild) {
      currentChild.remove();
      continue;
    }
    if (!currentChild) {
      current.append(nextChild);
      index += 1;
      continue;
    }
    reconcileNode(currentChild, nextChild);
    index += 1;
  }
}

export function renderMarkdown(container, markdown) {
  container.classList.add("markdown-body");
  const rendered = document.createElement("div");

  for (const block of parseMarkdownBlocks(markdown)) {
    let element;
    if (block.type === "heading") {
      element = document.createElement(`h${Math.min(6, Math.max(1, block.level))}`);
      renderInline(element, block.text);
    } else if (block.type === "code") {
      element = document.createElement("pre");
      const code = document.createElement("code");
      if (block.language) code.dataset.language = block.language;
      code.textContent = block.text;
      element.append(code);
    } else if (block.type === "table") {
      element = renderTable(block);
    } else if (block.type === "list") {
      element = document.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const listItem = document.createElement("li");
        renderInline(listItem, item);
        element.append(listItem);
      }
    } else if (block.type === "quote") {
      element = document.createElement("blockquote");
      renderInline(element, block.text);
    } else if (block.type === "separator") {
      element = document.createElement("hr");
    } else {
      element = document.createElement("p");
      renderInline(element, block.text);
    }
    rendered.append(element);
  }
  reconcileChildren(container, rendered);
}
