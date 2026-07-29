export function createBrowserToolRunner({
  isUiAction,
  avatarController,
  successStateDurationMs,
  errorStateDurationMs,
  inspectScreenshot,
  sendBrowserTool,
  showCapturedScreenshot,
  collectVerification,
  setRunning,
  setStatus,
  refreshTarget,
}) {
  return async function runBrowserTool(tool, args) {
    setRunning(true);
    const uiAction = isUiAction(tool);
    avatarController.transitionState(uiAction ? "ui_control" : "thinking");
    try {
      let result = tool === "browser_inspect_screenshot"
        ? await inspectScreenshot()
        : await sendBrowserTool(tool, args);
      if (tool === "browser_capture_screenshot" && result?.previewDataUrl) {
        showCapturedScreenshot(result);
        result = { ...result };
        delete result.previewDataUrl;
      }
      if (uiAction) {
        result = {
          ...result,
          controllerVerification: await collectVerification({ tool, args, result }),
        };
        if (result?.success === false) {
          avatarController.transitionState("error", { forMs: errorStateDurationMs });
        } else {
          avatarController.transitionState("success", {
            forMs: successStateDurationMs,
            resumeState: "thinking",
          });
        }
      } else {
        avatarController.transitionState("thinking");
      }
      return result;
    } catch (error) {
      avatarController.transitionState("error", { forMs: errorStateDurationMs });
      if (tool === "browser_upload_file") {
        const detail = error instanceof Error ? error.message : String(error || "Unknown upload error.");
        setStatus(`Upload failed: ${detail}`);
      }
      throw error;
    } finally {
      setRunning(false);
      void refreshTarget();
    }
  };
}
