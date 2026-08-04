import { BUILTIN_TOOLS } from "../live/session-config.js";
import { LOCAL_EXCEL_PROVIDER } from "../documents/excel-registry.js";

function builtInCategory(toolName) {
  if (String(toolName).startsWith("browser_")) return "Browser";
  if (toolName === "live_translate") return "Live translation";
  if (["get_transcript", "video_summary"].includes(toolName)) return "Video";
  return "Lumi";
}

export function createBuiltInToolInventory() {
  const extensionTools = BUILTIN_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    category: builtInCategory(tool.name),
    permission: "allow",
    alwaysEnabled: true,
    gemini: { enabled: true },
  }));
  const excelTools = LOCAL_EXCEL_PROVIDER.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    category: LOCAL_EXCEL_PROVIDER.serverName,
    permission: tool.permission,
    alwaysEnabled: true,
    gemini: { enabled: tool.gemini?.enabled === true },
  }));
  return Object.freeze([...extensionTools, ...excelTools].map(Object.freeze));
}
