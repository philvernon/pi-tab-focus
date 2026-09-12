type ScrollIndicatorTui = {
  mode: string;
  scrollToEndIndicator?: () => string;
};

type BorderRenderer = (width: number, hiddenLineCount: number) => string;

type BorderRenderableEditor = object & {
  renderTopBorder?: BorderRenderer;
  renderBottomBorder?: BorderRenderer;
};

const DASHED_BORDER_GLYPH = "·";
const SOLID_BORDER_GLYPH = "─";

function patchBorderRenderer(
  editor: BorderRenderableEditor,
  key: "renderTopBorder" | "renderBottomBorder",
  isTranscriptFocused: () => boolean,
): (() => void) | undefined {
  const original = editor[key];
  if (typeof original !== "function") return undefined;

  const hadOwnProperty = Object.prototype.hasOwnProperty.call(editor, key);
  const ownDescriptor = hadOwnProperty
    ? Object.getOwnPropertyDescriptor(editor, key)
    : undefined;

  const wrapped: BorderRenderer = function(
    this: BorderRenderableEditor,
    width,
    hiddenLineCount,
  ) {
    const rendered = original.call(this, width, hiddenLineCount);
    return isTranscriptFocused()
      ? rendered.replaceAll(SOLID_BORDER_GLYPH, DASHED_BORDER_GLYPH)
      : rendered;
  };

  try {
    Object.defineProperty(editor, key, {
      configurable: true,
      writable: true,
      value: wrapped,
    });
  } catch {
    return undefined;
  }

  return () => {
    // Avoid clobbering a later decorator that replaced this method after us.
    if (editor[key] !== wrapped) return;

    if (hadOwnProperty && ownDescriptor) {
      Object.defineProperty(editor, key, ownDescriptor);
    } else {
      delete editor[key];
    }
  };
}

export function installTranscriptEditorBorderStyle(
  editor: object,
  isTranscriptFocused: () => boolean,
): (() => void) | undefined {
  const target = editor as BorderRenderableEditor;
  const restorers = [
    patchBorderRenderer(target, "renderTopBorder", isTranscriptFocused),
    patchBorderRenderer(target, "renderBottomBorder", isTranscriptFocused),
  ].filter((restore): restore is () => void => restore !== undefined);

  if (restorers.length === 0) return undefined;

  return () => {
    for (let index = restorers.length - 1; index >= 0; index--) {
      restorers[index]();
    }
  };
}

export function suppressDefaultScrollIndicator(
  tui: ScrollIndicatorTui,
  enabled: boolean,
): (() => void) | undefined {
  if (
    !enabled ||
    tui.mode !== "fullscreen" ||
    !("scrollToEndIndicator" in tui)
  ) {
    return undefined;
  }

  const previous = tui.scrollToEndIndicator;
  tui.scrollToEndIndicator = undefined;

  return () => {
    tui.scrollToEndIndicator = previous;
  };
}
