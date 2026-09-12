import type { Component } from "@earendil-works/pi-tui";

type TextStyle = (text: string) => string;

type ScrollIndicatorTui = {
  mode: string;
  scrollToEndIndicator?: () => string;
};

export const EDITOR_FOCUS_INDICATOR_WIDTH = 1;

class EditorFocusIndicatorComponent implements Component {
  private readonly isEditorFocused: () => boolean;
  private readonly activeStyle: TextStyle;
  private readonly inactiveStyle: TextStyle;

  constructor(
    isEditorFocused: () => boolean,
    activeStyle: TextStyle,
    inactiveStyle: TextStyle,
  ) {
    this.isEditorFocused = isEditorFocused;
    this.activeStyle = activeStyle;
    this.inactiveStyle = inactiveStyle;
  }

  render(_width: number): string[] {
    const active = this.isEditorFocused();
    const marker = active ? "●" : "·";
    const style = active ? this.activeStyle : this.inactiveStyle;
    return [style(marker), style(marker), style(marker)];
  }

  invalidate(): void {}
}

export function createEditorFocusIndicator(
  isEditorFocused: () => boolean,
  activeStyle: TextStyle,
  inactiveStyle: TextStyle,
): Component {
  return new EditorFocusIndicatorComponent(
    isEditorFocused,
    activeStyle,
    inactiveStyle,
  );
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
