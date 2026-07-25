const AUTHORIZATION_REVIEW_PATTERN = /(explicit confirmation|confirmed=true|authorize the exact|ask the user to authorize)/i;
const HARD_BROWSER_BLOCKER_PATTERN = /(permission|not allowed|chrome:\/\/|chrome does not expose|file (?:was )?not found|does not exist|already being controlled by devtools|another debugger|blocks typing|password|passcode|otp|api key|access token|cancelled by the user)/i;

export function buildBrowserToolFailureResponse(error) {
  const detail = (error instanceof Error ? error.message : String(error || "Browser tool failed."))
    .slice(0, 1200);
  if (AUTHORIZATION_REVIEW_PATTERN.test(detail)) {
    return {
      error: detail,
      recoverable: true,
      blockerType: "authorization_check",
      authorizationReviewRequired: true,
      guidance: "Compare this action with the original current user request. If that request already explicitly authorized the exact action, target, and scope, retry immediately with confirmed=true without asking again. Ask the user only if the authorization is absent, ambiguous, materially expanded, or crosses a separate mandatory confirmation boundary.",
    };
  }
  const hardBlocker = HARD_BROWSER_BLOCKER_PATTERN.test(detail);
  if (hardBlocker) {
    return {
      error: detail,
      recoverable: false,
      blockerType: "hard",
      guidance: "Report this exact blocker and the user action or permission required to continue.",
    };
  }
  return {
    error: detail,
    recoverable: true,
    blockerType: "state_or_interaction",
    recoveryRequired: true,
    guidance: "Do not stop yet. Observe fresh semantic page state, use exact object or action text as a query, wait for dynamic UI when relevant, obtain new indices, and try a distinct safe interaction path before reporting failure.",
  };
}
