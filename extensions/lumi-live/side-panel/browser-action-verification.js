export const MAX_AUTOMATIC_VERIFICATION_CHARS = 8000;

export function automaticVerificationQuery(tool, args = {}, result = {}) {
  if (result?.nextPageStateQuery) return String(result.nextPageStateQuery).slice(0, 500);
  if (tool === "browser_select_option") return String(args.optionText || "").slice(0, 500);
  if (tool === "browser_scroll" && args.text) return String(args.text).slice(0, 500);
  return "";
}

export async function collectAutomaticBrowserVerification({
  tool,
  args = {},
  result = {},
  readPageState,
} = {}) {
  if (result?.success === false) {
    return {
      available: false,
      conclusive: false,
      source: "action_failure",
      error: result.error || result.message || "The browser action failed.",
    };
  }
  if (
    ["browser_open_tab", "browser_switch_tab"].includes(tool)
    && result?.url
  ) {
    return {
      available: true,
      conclusive: true,
      source: "tab_navigation_result",
      title: result.title || "",
      url: result.url,
      tabId: result.tabId,
      controllable: result.controllable !== false,
      summary: `Active tab is now ${result.title || result.url}.`,
    };
  }
  const query = automaticVerificationQuery(tool, args, result);
  try {
    const state = await readPageState(query);
    return {
      available: true,
      conclusive: result?.requiresPageVerification !== true,
      source: "automatic_post_action_page_state",
      query,
      queryMatched: query ? state?.queryMatched === true : undefined,
      title: state?.title || "",
      url: state?.url || "",
      content: String(state?.content || "").slice(
        0,
        MAX_AUTOMATIC_VERIFICATION_CHARS,
      ),
    };
  } catch (error) {
    return {
      available: false,
      conclusive: false,
      source: "automatic_post_action_page_state",
      query,
      error: (error instanceof Error ? error.message : String(error || ""))
        .slice(0, 1200),
    };
  }
}
