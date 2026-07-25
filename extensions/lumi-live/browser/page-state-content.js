export const MAX_PAGE_STATE_CHARACTERS = 16000;
export const MAX_PAGE_STATE_QUERY_CHARACTERS = 240;

function clipAtLineBoundary(content, start, end) {
  let boundedStart = Math.max(0, start);
  let boundedEnd = Math.min(content.length, end);
  if (boundedStart > 0) {
    const nextNewline = content.indexOf("\n", boundedStart);
    if (nextNewline > -1 && nextNewline < boundedEnd) boundedStart = nextNewline + 1;
  }
  if (boundedEnd < content.length) {
    const previousNewline = content.lastIndexOf("\n", boundedEnd);
    if (previousNewline > boundedStart) boundedEnd = previousNewline;
  }
  return content.slice(boundedStart, boundedEnd);
}

export function selectPageStateContent(
  value,
  queryValue = "",
  maxCharacters = MAX_PAGE_STATE_CHARACTERS,
) {
  const content = String(value || "");
  const query = String(queryValue || "")
    .trim()
    .slice(0, MAX_PAGE_STATE_QUERY_CHARACTERS);
  const limit = Math.max(1000, Number(maxCharacters) || MAX_PAGE_STATE_CHARACTERS);

  if (!query) {
    return {
      content: content.length > limit
        ? `${clipAtLineBoundary(content, 0, limit)}\n[Page state truncated]`
        : content,
      originalContentLength: content.length,
      query: "",
      queryMatched: false,
    };
  }

  const matchIndex = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (matchIndex < 0) {
    const prefix = content.length > limit
      ? `${clipAtLineBoundary(content, 0, limit)}\n[Page state truncated]`
      : content;
    return {
      content: `${prefix}\n[Requested text "${query}" was not found in the current semantic DOM.]`,
      originalContentLength: content.length,
      query,
      queryMatched: false,
    };
  }

  if (content.length <= limit) {
    return {
      content,
      originalContentLength: content.length,
      query,
      queryMatched: true,
    };
  }

  const contextBefore = Math.floor(limit * 0.42);
  const start = Math.max(0, matchIndex - contextBefore);
  const excerpt = clipAtLineBoundary(content, start, start + limit);
  return {
    content: [
      start > 0 ? "[Earlier page state omitted]" : "",
      excerpt,
      start + limit < content.length ? "[Later page state omitted]" : "",
    ].filter(Boolean).join("\n"),
    originalContentLength: content.length,
    query,
    queryMatched: true,
  };
}
