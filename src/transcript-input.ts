import {
  Key,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type EditorComponent,
  type KeyId,
} from "@earendil-works/pi-tui";
import type { FullscreenTui } from "./fullscreen-layout.ts";

export type TranscriptEditor = EditorComponent & {
  getMode?: () => string;
  actionHandlers?: Map<string, () => void>;
};

export type AppKeybindings = {
  matches?: (data: string, keybinding: string) => boolean;
};

const TRANSCRIPT_LAYOUT_ACTIONS = [
  "app.tools.expand",
  "app.thinking.toggle",
] as const;

type TranscriptInputDependencies = {
  focusKey: KeyId;
  getTui: () => FullscreenTui | undefined;
  getEditor: () => TranscriptEditor | undefined;
  getAppKeybindings: () => AppKeybindings | undefined;
  isFocused: () => boolean;
  isExDetour: () => boolean;
  setExReturnArmed: () => void;
  reconcileFullscreenMode: () => void;
  transientUiHasFocus: () => boolean;
  checkExReturnAfterInput: () => void;
  reclaimTranscriptFocus: () => void;
  finishExDetour: () => void;
  inVisualMode: () => boolean;
  finishVisualMode: (options?: { restoreGutter: boolean }) => void;
  leaveTranscriptMode: () => void;
  enterTranscriptMode: () => void;
  refreshSelectionGeometry: () => void;
  shutdown: () => void;
  handleVisualInput: (data: string) => boolean;
  enterVisualMode: () => void;
  openSelectedItemLink: () => void;
  enterExDetour: () => void;
  syncSelectionToViewport: (direction: -1 | 1) => void;
  halfPage: (direction: -1 | 1) => void;
  selectItem: (direction: -1 | 1) => void;
  page: (direction: -1 | 1) => void;
  copySelectedItem: () => void;
};

export function normalizeVisualKey(data: string): string {
  if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+[")) {
    return "escape";
  }
  if (matchesKey(data, Key.enter)) return "enter";
  if (matchesKey(data, Key.left)) return "h";
  if (matchesKey(data, Key.right)) return "l";
  if (matchesKey(data, Key.up)) return "k";
  if (matchesKey(data, Key.down)) return "j";
  if (data === ":" || matchesKey(data, Key.colon)) return ":";
  return data;
}

export function createTranscriptInputHandler(
  deps: TranscriptInputDependencies,
) {
  return (data: string) => {
    // Pi can replace the active renderer at runtime without rebuilding the
    // custom editor. Reconcile cached fullscreen integration before touching
    // focus, viewport or selection state for this input event.
    deps.reconcileFullscreenMode();

    const tui = deps.getTui();
    const editor = deps.getEditor();

    // When another Pi/custom component has actual TUI focus, it owns input.
    // This covers select/confirm/input/editor prompts and capturing overlays.
    if (deps.transientUiHasFocus()) {
      if (deps.isExDetour()) deps.checkExReturnAfterInput();
      return undefined;
    }

    // Pi restores editor focus when a transient component closes. Transcript
    // mode is logically still active, so reclaim its normal null-focus state.
    if (!deps.isExDetour()) deps.reclaimTranscriptFocus();

    // Raw input listeners run before Pi filters key-release events.
    if (isKeyRelease(data)) return undefined;

    // When pi-vim is present, `:` is a temporary detour into its EX mini-mode.
    // While it is active, let the editor/Pi own input normally. Enter or Escape
    // ends EX input; if the command opens an overlay, subsequent overlay input
    // keeps checking until Pi restores focus to the editor, then transcript
    // mode resumes.
    if (deps.isExDetour()) {
      // The configured focus key keeps its transcript-focus meaning while the
      // EX mini-mode is active. Cancel EX and return to transcript navigation.
      if (matchesKey(data, deps.focusKey)) {
        if (!isKeyRepeat(data)) {
          editor?.handleInput("\x1b");
          deps.finishExDetour();
        }
        return { consume: true };
      }

      if (
        matchesKey(data, Key.enter) ||
        matchesKey(data, Key.escape) ||
        matchesKey(data, "ctrl+[")
      ) {
        deps.setExReturnArmed();
      }
      deps.checkExReturnAfterInput();
      return undefined;
    }

    if (matchesKey(data, deps.focusKey)) {
      // Outside fullscreen, the configured focus key belongs entirely to Pi.
      if (!deps.isFocused() && tui?.mode !== "fullscreen") return undefined;

      // Holding the focus key must not repeatedly flip focus on key-repeat events.
      if (!isKeyRepeat(data)) {
        if (deps.inVisualMode()) {
          deps.finishVisualMode({ restoreGutter: false });
        }
        if (deps.isFocused()) deps.leaveTranscriptMode();
        else deps.enterTranscriptMode();
      }
      return { consume: true };
    }

    if (!deps.isFocused()) return undefined;

    const transcriptLayoutAction = TRANSCRIPT_LAYOUT_ACTIONS.find((action) =>
      deps.getAppKeybindings()?.matches?.(data, action),
    );
    if (transcriptLayoutAction) {
      if (!isKeyRepeat(data)) {
        if (deps.inVisualMode()) deps.finishVisualMode();
        const handler = editor?.actionHandlers?.get(transcriptLayoutAction);
        if (handler) handler();
        else editor?.handleInput(data);
        deps.refreshSelectionGeometry();
      }
      return { consume: true };
    }

    if (matchesKey(data, "ctrl+d")) {
      deps.shutdown();
      return { consume: true };
    }

    // Leave transcript focus on Ctrl+C; once the editor owns focus again,
    // subsequent Ctrl+C input follows Pi's normal handling.
    if (matchesKey(data, "ctrl+c")) {
      if (deps.inVisualMode()) {
        deps.finishVisualMode({ restoreGutter: false });
      }
      deps.leaveTranscriptMode();
      return { consume: true };
    }

    if (deps.inVisualMode()) {
      return deps.handleVisualInput(data) ? { consume: true } : undefined;
    }

    if (matchesKey(data, Key.escape)) {
      deps.leaveTranscriptMode();
      return { consume: true };
    }

    if (data === "v") {
      deps.enterVisualMode();
      return { consume: true };
    }

    if (data === "V") {
      deps.enterVisualMode();
      if (deps.inVisualMode()) deps.handleVisualInput("V");
      return { consume: true };
    }

    if (matchesKey(data, Key.enter)) {
      deps.openSelectedItemLink();
      return { consume: true };
    }

    if (data === ":" || matchesKey(data, Key.colon)) {
      deps.enterExDetour();
      return { consume: true };
    }

    if (data === "j" || matchesKey(data, Key.down)) {
      tui?.scrollBy?.(1);
      deps.syncSelectionToViewport(1);
      return { consume: true };
    }

    if (data === "k" || matchesKey(data, Key.up)) {
      tui?.scrollBy?.(-1);
      deps.syncSelectionToViewport(-1);
      return { consume: true };
    }

    if (data === "u") {
      deps.halfPage(-1);
      deps.syncSelectionToViewport(-1);
      return { consume: true };
    }

    if (data === "d") {
      deps.halfPage(1);
      deps.syncSelectionToViewport(1);
      return { consume: true };
    }

    if (
      data === "J" ||
      matchesKey(data, Key.shift("j")) ||
      matchesKey(data, Key.shift("down"))
    ) {
      deps.selectItem(1);
      return { consume: true };
    }

    if (
      data === "K" ||
      matchesKey(data, Key.shift("k")) ||
      matchesKey(data, Key.shift("up"))
    ) {
      deps.selectItem(-1);
      return { consume: true };
    }

    if (data === "b" || matchesKey(data, Key.pageUp)) {
      deps.page(-1);
      deps.syncSelectionToViewport(-1);
      return { consume: true };
    }

    if (data === "f" || matchesKey(data, Key.pageDown)) {
      deps.page(1);
      deps.syncSelectionToViewport(1);
      return { consume: true };
    }

    if (data === "g" || matchesKey(data, Key.home)) {
      tui?.scrollToTop?.();
      deps.syncSelectionToViewport(-1);
      return { consume: true };
    }

    if (data === "G" || matchesKey(data, Key.end)) {
      tui?.scrollToBottom?.();
      deps.syncSelectionToViewport(1);
      return { consume: true };
    }

    if (data === "y" || data === "c") {
      deps.copySelectedItem();
      return { consume: true };
    }

    // Transcript mode keeps TUI focus at null, so unrecognised input cannot
    // edit the prompt editor. Leave it unconsumed so other extensions' raw
    // terminal-input listeners can handle their own shortcuts.
    return undefined;
  };
}
