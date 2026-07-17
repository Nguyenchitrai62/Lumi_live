const SENSITIVE_CONTEXT_PARAMETER = /^(?:access[_-]?token|id[_-]?token|refresh[_-]?token|api[_-]?key|auth(?:orization)?|password|passwd|secret|signature|jwt|session[_-]?token|credential)$/i;
const CONTEXT_IDENTIFIER_PARAMETER = /(?:id|file|filename|document|doc|project|folder|node|revision|rev|version)/i;

export function sanitizeActiveContextUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_CONTEXT_PARAMETER.test(key)) url.searchParams.set(key, "[redacted]");
    }
    url.hash = url.hash.replace(
      /((?:access[_-]?token|id[_-]?token|refresh[_-]?token|api[_-]?key|authorization|password|secret|signature|jwt|session[_-]?token|credential)=)[^&]+/gi,
      "$1[redacted]",
    );
    return url.href.slice(0, 3000);
  } catch {
    return "";
  }
}

export function extractActiveContextIdentifiers(safeUrl) {
  try {
    const url = new URL(safeUrl);
    const identifiers = [];
    for (const [name, value] of url.searchParams) {
      if (!CONTEXT_IDENTIFIER_PARAMETER.test(name) || value === "[redacted]") continue;
      identifiers.push({ name, value: value.slice(0, 400), source: "query" });
    }
    return {
      identifiers: identifiers.slice(0, 24),
      pathSegments: url.pathname.split("/")
        .filter(Boolean)
        .slice(-8)
        .map((segment) => {
          try { return decodeURIComponent(segment).slice(0, 300); } catch { return segment.slice(0, 300); }
        }),
    };
  } catch {
    return { identifiers: [], pathSegments: [] };
  }
}
