const LUMI_PAGE_SOURCE = "lumi-live-web";
const LUMI_EXTENSION_SOURCE = "lumi-page-agent-extension";
const BRIDGE_REQUEST_TYPE = "lumi_page_agent_request";

function postBridgeResponse(origin, requestId, response) {
  window.postMessage({
    source: LUMI_EXTENSION_SOURCE,
    type: "response",
    requestId,
    ...response,
  }, origin);
}

function describeBridgeError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  let runtimeAvailable = false;
  try {
    runtimeAvailable = Boolean(chrome.runtime?.id);
  } catch {
    runtimeAvailable = false;
  }
  if (/extension context invalidated/i.test(message) || !runtimeAvailable) {
    return "Lumi PageAgent Controller was reloaded. Refresh the Lumi web tab once to reconnect its bridge.";
  }
  return message || "Lumi extension bridge failed.";
}

function handlePageMessage(event) {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data;
  if (message?.source !== LUMI_PAGE_SOURCE || message?.type !== "request") return;

  try {
    if (!chrome.runtime?.id) {
      throw new Error("Extension context invalidated.");
    }
    Promise.resolve(chrome.runtime.sendMessage({
      type: BRIDGE_REQUEST_TYPE,
      requestId: message.requestId,
      tool: message.tool,
      args: message.args || {},
    })).then((response) => {
      postBridgeResponse(event.origin, message.requestId, {
        ok: Boolean(response?.ok),
        result: response?.result,
        error: response?.error,
      });
    }).catch((error) => {
      const errorMessage = describeBridgeError(error);
      if (/reloaded/i.test(errorMessage)) {
        window.removeEventListener("message", handlePageMessage);
      }
      postBridgeResponse(event.origin, message.requestId, {
        ok: false,
        error: errorMessage,
      });
    });
  } catch (error) {
    window.removeEventListener("message", handlePageMessage);
    postBridgeResponse(event.origin, message.requestId, {
      ok: false,
      error: describeBridgeError(error),
    });
  }
}

window.addEventListener("message", handlePageMessage);
