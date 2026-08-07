export function isDynamicRecordedUrlSegment(value) {
  return /^\d{2,}$/.test(value)
    || /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(value)
    || /^[0-9a-z_-]{20,}$/i.test(value);
}

function isPlausibleRouteValue(value) {
  const candidate = String(value || "").trim();
  return Boolean(candidate)
    && candidate.length <= 512
    && candidate !== "."
    && candidate !== "..";
}

export function recordedUrlValueMatches(actual, expected) {
  if (expected === "[redacted]" || actual === expected) return true;
  // A recorded identifier describes a dynamic route slot, not one immutable
  // database record. Keep the surrounding route strict while allowing the
  // application to produce a new ID, slug, or temporary sentinel such as
  // "undefined" during create/import flows.
  return isDynamicRecordedUrlSegment(expected) && isPlausibleRouteValue(actual);
}

function recordedUrlHashMatches(actualHash, expectedHash) {
  if (!expectedHash || expectedHash.includes("[redacted]")) return true;
  const actualParts = actualHash.replace(/^#/, "").split("/");
  const expectedParts = expectedHash.replace(/^#/, "").split("/");
  return actualParts.length === expectedParts.length
    && expectedParts.every((part, index) => recordedUrlValueMatches(actualParts[index], part));
}

export function recordedFlowUrlMatches(actualValue, expectedValue) {
  try {
    const actual = new URL(actualValue);
    const expected = new URL(expectedValue);
    if (actual.origin !== expected.origin) return false;
    const actualParts = actual.pathname.split("/").filter(Boolean);
    const expectedParts = expected.pathname.split("/").filter(Boolean);
    if (actualParts.length !== expectedParts.length) return false;
    if (!expectedParts.every((part, index) => (
      recordedUrlValueMatches(actualParts[index], part)
    ))) return false;
    for (const [key, value] of expected.searchParams) {
      const actualValues = actual.searchParams.getAll(key);
      if (!actualValues.some((candidate) => recordedUrlValueMatches(candidate, value))) {
        return false;
      }
    }
    return recordedUrlHashMatches(actual.hash, expected.hash);
  } catch {
    return String(actualValue || "") === String(expectedValue || "");
  }
}
