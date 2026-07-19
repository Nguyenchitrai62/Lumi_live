import { wait } from "./timing.js";

function setNativeControlValue(element, value) {
  const elementWindow = element.ownerDocument.defaultView || window;
  const prototype = element.tagName === "TEXTAREA"
    ? elementWindow.HTMLTextAreaElement.prototype
    : elementWindow.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) throw new Error("The input does not expose a native value setter.");
  setter.call(element, value);
  try {
    element.setSelectionRange(value.length, value.length);
  } catch {
    // Some input types, such as number and date, do not expose a text selection.
  }
}

function replaceTextAndDispatchInput(element, value, inputType, data = null) {
  const elementWindow = element.ownerDocument.defaultView || window;
  const InputEventConstructor = elementWindow.InputEvent || InputEvent;
  element.dispatchEvent(new InputEventConstructor("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType,
    data,
  }));
  replaceVisibleText(element, value);
  element.dispatchEvent(new InputEventConstructor("input", {
    bubbles: true,
    inputType,
    data,
  }));
}

function replaceVisibleText(element, value) {
  if (element.isContentEditable) {
    element.innerText = value;
    return;
  }
  setNativeControlValue(element, value);
}

export async function typeTextGradually(element, text, durationMs, signal) {
  const isTextControl = element?.tagName === "INPUT"
    || element?.tagName === "TEXTAREA"
    || element?.isContentEditable;
  if (!isTextControl) {
    throw new Error("Element is not an input, textarea, or contenteditable.");
  }

  const elementWindow = element.ownerDocument.defaultView || window;
  const rawText = String(text);
  const segmenter = elementWindow.Intl?.Segmenter
    ? new elementWindow.Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;
  const characters = segmenter
    ? [...segmenter.segment(rawText)].map(({ segment }) => segment)
    : Array.from(rawText);
  const duration = Math.max(0, Number(durationMs) || 0);
  const originalValue = element.isContentEditable ? element.innerText : element.value;
  const throwIfCancelled = () => {
    if (signal?.aborted) throw new DOMException("The page action was cancelled by the user.", "AbortError");
  };
  throwIfCancelled();
  element.focus({ preventScroll: true });
  replaceTextAndDispatchInput(element, "", "deleteContentBackward");

  try {
    if (characters.length && duration > 0) {
      const startedAt = elementWindow.performance.now();
      let renderedCount = 0;
      while (renderedCount < characters.length) {
        throwIfCancelled();
        const elapsed = elementWindow.performance.now() - startedAt;
        const nextCount = Math.min(
          characters.length,
          Math.max(1, Math.ceil((elapsed / duration) * characters.length)),
        );
        if (nextCount > renderedCount) {
          const insertedText = characters.slice(renderedCount, nextCount).join("");
          replaceTextAndDispatchInput(
            element,
            characters.slice(0, nextCount).join(""),
            "insertText",
            insertedText,
          );
          renderedCount = nextCount;
        }
        if (renderedCount < characters.length) {
          await new Promise((resolve) => elementWindow.requestAnimationFrame(resolve));
        }
      }
      const remaining = duration - (elementWindow.performance.now() - startedAt);
      if (remaining > 0) await wait(remaining);
    } else if (characters.length) {
      replaceTextAndDispatchInput(element, characters.join(""), "insertText", characters.join(""));
    }
    throwIfCancelled();
  } catch (error) {
    if (signal?.aborted) {
      replaceTextAndDispatchInput(element, originalValue, "insertReplacementText", originalValue);
    }
    element.blur();
    throw error;
  }

  const EventConstructor = elementWindow.Event || Event;
  element.dispatchEvent(new EventConstructor("change", { bubbles: true }));
  element.blur();
}
