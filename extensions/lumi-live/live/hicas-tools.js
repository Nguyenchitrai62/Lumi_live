export const HICAS_SKILL_TOOL_NAME = "hicas_get_skill_context";

export const HICAS_SKILL_TOOL = Object.freeze({
  name: HICAS_SKILL_TOOL_NAME,
  description: "Load the packaged, sanitized HICAS ERP operating knowledge for the current route, module, control, data field, workflow, or coverage question. On sit.hawee.hicas.vn call this before the first browser action and whenever the route/module changes. Only records returned as verified are eligible for fast-path execution; all other statuses require fresh observation.",
  parameters: {
    type: "OBJECT",
    properties: {
      url: {
        type: "STRING",
        description: "Current complete HICAS URL. Omit only when the active browser context already supplies it.",
      },
      module: {
        type: "STRING",
        description: "Optional module such as navigation, materials, labor, warehouse, administration, buttons, data-dictionary, workflows, or coverage.",
      },
      query: {
        type: "STRING",
        description: "Optional concise route, screen, control, field, or workflow query.",
      },
      sections: {
        type: "ARRAY",
        items: { type: "STRING" },
        maxItems: 6,
        description: "Optional exact reference module names to prioritize.",
      },
    },
  },
});

export function isHicasSkillTool(name) {
  return String(name || "") === HICAS_SKILL_TOOL_NAME;
}
