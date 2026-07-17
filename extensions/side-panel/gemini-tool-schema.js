const GEMINI_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inferSchemaType(schema, enumValues) {
  if (isObject(schema.properties)) return "object";
  if (Object.hasOwn(schema, "items")) return "array";
  const firstValue = enumValues?.find((value) => value !== null);
  if (typeof firstValue === "string") return "string";
  if (typeof firstValue === "boolean") return "boolean";
  if (typeof firstValue === "number") return Number.isInteger(firstValue) ? "integer" : "number";
  return null;
}

function normalizeCount(value, path, diagnostics) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  diagnostics.warnings.push(`${path} was ignored because it must be a non-negative integer.`);
  return null;
}

function normalizeSchema(schema, path, diagnostics, depth = 0) {
  if (!isObject(schema)) {
    diagnostics.errors.push(`${path} must be a JSON Schema object.`);
    return {};
  }
  if (depth > 24) {
    diagnostics.errors.push(`${path} is nested too deeply for Gemini Live.`);
    return {};
  }

  const enumValues = Object.hasOwn(schema, "const") ? [schema.const] : schema.enum;
  const rawTypes = Array.isArray(schema.type)
    ? schema.type
    : typeof schema.type === "string" ? [schema.type] : [];
  if (Object.hasOwn(schema, "type") && !rawTypes.length) {
    diagnostics.errors.push(`${path}.type must be a string or an array of strings.`);
  }

  const types = rawTypes.map((value) => String(value).toLowerCase());
  const unsupportedTypes = types.filter((value) => !GEMINI_TYPES.has(value));
  if (unsupportedTypes.length) {
    diagnostics.errors.push(`${path}.type uses unsupported value ${unsupportedTypes[0]}.`);
  }
  const concreteTypes = types.filter((value) => value !== "null" && GEMINI_TYPES.has(value));
  if (new Set(concreteTypes).size > 1) {
    diagnostics.errors.push(`${path}.type contains multiple non-null types; use anyOf instead.`);
  }

  const variantSource = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf) ? schema.oneOf : [];
  if (Array.isArray(schema.oneOf) && !Array.isArray(schema.anyOf)) {
    diagnostics.warnings.push(`${path}.oneOf was converted to Gemini anyOf.`);
  }

  const normalized = {};
  const type = concreteTypes[0] || (types.includes("null") && !concreteTypes.length
    ? "null"
    : inferSchemaType(schema, Array.isArray(enumValues) ? enumValues : null));
  if (type && GEMINI_TYPES.has(type)) normalized.type = type.toUpperCase();
  if (typeof schema.description === "string") normalized.description = schema.description.slice(0, 4000);
  if (typeof schema.title === "string") normalized.title = schema.title.slice(0, 500);
  if (schema.nullable === true || types.includes("null")) normalized.nullable = true;

  if (Array.isArray(enumValues)) {
    const primitiveValues = enumValues.filter((value) =>
      value !== null && ["string", "number", "boolean"].includes(typeof value));
    const droppedCount = enumValues.length - primitiveValues.length
      - (enumValues.includes(null) ? 1 : 0);
    if (enumValues.includes(null)) normalized.nullable = true;
    if (droppedCount > 0) {
      const message = `${path}.${Object.hasOwn(schema, "const") ? "const" : "enum"} contains values Gemini cannot represent.`;
      if (Object.hasOwn(schema, "const")) diagnostics.errors.push(message);
      else diagnostics.warnings.push(`${message} Those values were ignored.`);
    }
    const stringValues = [...new Set(primitiveValues.map(String))];
    if (stringValues.length) {
      normalized.enum = stringValues;
      normalized.format = "enum";
      if (primitiveValues.some((value) => typeof value !== "string")) {
        diagnostics.warnings.push(`${path}.enum values were encoded as strings for Gemini.`);
      }
    }
  }

  if (!normalized.enum && typeof schema.format === "string") normalized.format = schema.format;

  if (Object.hasOwn(schema, "properties") && !isObject(schema.properties)) {
    diagnostics.errors.push(`${path}.properties must be an object.`);
  } else if (isObject(schema.properties)) {
    normalized.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        normalizeSchema(value, `${path}.properties.${key}`, diagnostics, depth + 1),
      ]),
    );
  } else if (normalized.type === "OBJECT") {
    normalized.properties = {};
  }

  if (Array.isArray(schema.required)) {
    const propertyNames = new Set(Object.keys(normalized.properties || {}));
    const required = [...new Set(schema.required.filter((value) =>
      typeof value === "string" && propertyNames.has(value)))];
    if (required.length) normalized.required = required;
    if (required.length !== schema.required.length) {
      diagnostics.warnings.push(`${path}.required contained invalid or unknown property names.`);
    }
  } else if (Object.hasOwn(schema, "required")) {
    diagnostics.warnings.push(`${path}.required was ignored because it must be an array.`);
  }

  if (Object.hasOwn(schema, "items")) {
    normalized.items = normalizeSchema(schema.items, `${path}.items`, diagnostics, depth + 1);
  }

  const concreteVariants = variantSource.filter((variant) => variant?.type !== "null");
  if (variantSource.some((variant) => variant?.type === "null")) normalized.nullable = true;
  if (concreteVariants.length) {
    normalized.anyOf = concreteVariants.map((variant, index) =>
      normalizeSchema(variant, `${path}.anyOf[${index}]`, diagnostics, depth + 1));
  }

  for (const key of ["minimum", "maximum"]) {
    if (!Object.hasOwn(schema, key)) continue;
    if (typeof schema[key] === "number" && Number.isFinite(schema[key])) normalized[key] = schema[key];
    else diagnostics.warnings.push(`${path}.${key} was ignored because it must be a finite number.`);
  }
  for (const key of ["minItems", "maxItems", "minLength", "maxLength"]) {
    if (!Object.hasOwn(schema, key)) continue;
    const value = normalizeCount(schema[key], `${path}.${key}`, diagnostics);
    if (value !== null) normalized[key] = value;
  }
  if (Object.hasOwn(schema, "pattern")) {
    if (typeof schema.pattern === "string") normalized.pattern = schema.pattern;
    else diagnostics.warnings.push(`${path}.pattern was ignored because it must be a string.`);
  }

  return normalized;
}

export function prepareGeminiMcpTool(tool) {
  const diagnostics = { errors: [], warnings: [] };
  const name = typeof tool?.name === "string" ? tool.name.trim() : "";
  if (!name) diagnostics.errors.push("The MCP tool has no valid name.");

  const inputSchema = tool?.inputSchema === undefined
    ? { type: "object", properties: {} }
    : tool.inputSchema;
  const parameters = normalizeSchema(inputSchema, "inputSchema", diagnostics);
  if (parameters.type !== "OBJECT") {
    diagnostics.errors.push("inputSchema must have type object for a Gemini function declaration.");
  }

  return {
    enabled: diagnostics.errors.length === 0,
    parameters,
    errors: [...new Set(diagnostics.errors)],
    warnings: [...new Set(diagnostics.warnings)],
  };
}
