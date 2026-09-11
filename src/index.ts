import {
  copyToClipboard,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type EditorComponent,
  type TUI,
} from "@earendil-works/pi-tui";

type PiVimEditor = EditorComponent & {
  getMode?: () => string;
};

type FullscreenTui = TUI & {
  scrollBy?: (lines: number) => void;
  scrollToTop?: () => void;
  scrollToBottom?: () => void;
  // Present on TuiAltScreen at runtime, but currently private in its public type.
  scrollToPrompt?: (direction: -1 | 1) => void;
};

type PromptItem = {
  entryId: string;
  text: string;
};

type TranscriptContext = {
  sessionManager: {
    getBranch(): Array<{ type: string; id: string; message?: unknown }>;
  };
};

function userMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;

  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "user") return undefined;

  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return undefined;

  const chunks: string[] = [];
  for (const part of candidate.content) {
    if (!part || typeof part !== "object") continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string") chunks.push(text);
  }

  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function displayedUserPrompts(ctx: TranscriptContext): PromptItem[] {
  const prompts: PromptItem[] = [];

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const text = userMessageText(entry.message);
    if (text !== undefined) prompts.push({ entryId: entry.id, text });
  }

  return prompts;
}

export default function transcriptFocus(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const previousFactory = ctx.ui.getEditorComponent();
    if (!previousFactory) {
      ctx.ui.notify(
        "pi-tab-focus must be listed after pi-vim in settings.json packages.",
        "warning",
      );
      return;
    }

    let tui: FullscreenTui | undefined;
    let editor: PiVimEditor | undefined;
    let focused = false;
    let selectedPrompt = -1;
    let exDetour = false;
    let exReturnArmed = false;
    let exReturnCheck: ReturnType<typeof setTimeout> | undefined;

    const getPrompts = (): PromptItem[] =>
      displayedUserPrompts(ctx as unknown as TranscriptContext);

    const updateStatus = (): void => {
      if (!focused) {
        ctx.ui.setStatus("pi-tab-focus", undefined);
        return;
      }

      const prompts = getPrompts();
      const selection =
        selectedPrompt >= 0 && selectedPrompt < prompts.length
          ? ` • prompt ${selectedPrompt + 1}/${prompts.length}`
          : "";

      ctx.ui.setStatus(
        "pi-tab-focus",
        `TRANSCRIPT ↑↓/jk scroll • shift+↑↓/JK prompt • b/pgup up • f/pgdn down • c/y copy${selection} • : command • tab/esc exit`,
      );
    };

    const setFocused = (next: boolean): void => {
      if (next && tui?.mode !== "fullscreen") {
        focused = false;
        ctx.ui.setStatus("pi-tab-focus", undefined);
        ctx.ui.notify(
          "Transcript focus requires Pi fullscreen mode (--tui-mode fullscreen).",
          "warning",
        );
        return;
      }

      focused = next;

      // Transcript focus is real TUI focus, not just an input-routing flag.
      // Removing focus from pi-vim suppresses its CURSOR_MARKER, so Pi hides the
      // hardware caret while scrolling the transcript. This avoids cursor
      // show/hide/reposition flashes, which are particularly visible in tmux.
      if (tui) {
        tui.setFocus(focused ? null : (editor ?? null));
      }

      updateStatus();
    };

    const finishExDetour = (): void => {
      exDetour = false;
      exReturnArmed = false;
      if (exReturnCheck !== undefined) {
        clearTimeout(exReturnCheck);
        exReturnCheck = undefined;
      }
      setFocused(true);
    };

    const checkExReturnAfterInput = (): void => {
      if (!exDetour || !exReturnArmed || !tui || !editor) return;

      if (exReturnCheck !== undefined) clearTimeout(exReturnCheck);
      exReturnCheck = setTimeout(() => {
        exReturnCheck = undefined;
        if (!exDetour || !exReturnArmed || !tui || !editor) return;

        // EX commands may open a Pi overlay (for example a picker). Keep the
        // editor focused while that UI is active. Once the command/cancel path
        // has returned to the editor, restore transcript focus automatically.
        if (!tui.hasOverlay() && tui.getFocusedComponent() === editor) {
          finishExDetour();
        }
      }, 0);
    };

    const page = (direction: -1 | 1): void => {
      if (!tui) return;
      const lines = Math.max(1, tui.terminal.rows - 5);
      tui.scrollBy?.(direction * lines);
    };

    const selectPrompt = (direction: -1 | 1): void => {
      const prompts = getPrompts();
      if (prompts.length === 0) {
        selectedPrompt = -1;
        updateStatus();
        ctx.ui.notify("No user prompts in the current branch.", "info");
        return;
      }

      if (selectedPrompt < 0 || selectedPrompt >= prompts.length) {
        selectedPrompt = direction < 0 ? prompts.length - 1 : 0;
      } else {
        selectedPrompt = Math.max(
          0,
          Math.min(prompts.length - 1, selectedPrompt + direction),
        );
      }

      // Pi's fullscreen renderer has semantic OSC-133 markers for user prompts.
      // There is not yet a public API mapping those viewport rows back to session
      // entries, so logical selection and viewport movement remain best-effort.
      tui?.scrollToPrompt?.(direction);
      updateStatus();
    };

    const copySelectedPrompt = (): void => {
      const prompts = getPrompts();
      if (prompts.length === 0) {
        ctx.ui.notify("No user prompt selected.", "warning");
        return;
      }

      if (selectedPrompt < 0 || selectedPrompt >= prompts.length) {
        selectedPrompt = prompts.length - 1;
      }

      const text = prompts[selectedPrompt].text;
      updateStatus();

      void copyToClipboard(text).then(
        () => ctx.ui.notify("Copied selected prompt.", "info"),
        (error: unknown) =>
          ctx.ui.notify(
            `Failed to copy selected prompt: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          ),
      );
    };

    // Preserve pi-vim's real ModalEditor/CustomEditor instance. Pi can therefore
    // see and wire its actionHandlers, onEscape, onCtrlD, image-paste handler,
    // extension shortcuts and any future CustomEditor surface directly.
    ctx.ui.setEditorComponent((nextTui, theme, keybindings) => {
      tui = nextTui as FullscreenTui;
      editor = previousFactory(nextTui, theme, keybindings) as PiVimEditor;
      return editor;
    });

    // Transcript focus is an input mode, not an editor implementation. Handle it
    // before input reaches pi-vim and consume only keys owned by transcript mode.
    ctx.ui.onTerminalInput((data) => {
      // Raw input listeners see Kitty key-release events before component-level
      // filtering. Never treat a release as a second transcript-mode command.
      if (isKeyRelease(data)) {
        return focused ? { consume: true } : undefined;
      }

      // `:` is a temporary detour into pi-vim's EX mini-mode. While it is
      // active, let pi-vim/Pi own input normally. Enter or Escape ends EX input;
      // if the command opens an overlay, subsequent overlay input keeps checking
      // until Pi restores focus to the editor, then transcript mode resumes.
      if (exDetour) {
        // Tab keeps its transcript-focus meaning while the EX mini-mode itself
        // is active. Cancel the pending EX command and return to transcript
        // navigation instead of letting pi-vim treat Tab as completion.
        // Once an EX command has opened a Pi overlay, however, leave Tab to that
        // overlay so its own keyboard navigation remains intact.
        if (matchesKey(data, Key.tab) && !tui?.hasOverlay()) {
          if (!isKeyRepeat(data)) {
            editor?.handleInput("\x1b");
            finishExDetour();
          }
          return { consume: true };
        }

        if (
          matchesKey(data, Key.enter) ||
          matchesKey(data, Key.escape) ||
          matchesKey(data, "ctrl+[")
        ) {
          exReturnArmed = true;
        }
        checkExReturnAfterInput();
        return undefined;
      }

      if (matchesKey(data, Key.tab)) {
        // Holding Tab must not repeatedly flip focus on Kitty key-repeat events.
        if (!isKeyRepeat(data)) setFocused(!focused);
        return { consume: true };
      }

      if (!focused) return undefined;

      if (matchesKey(data, Key.escape)) {
        setFocused(false);
        return { consume: true };
      }

      if (data === ":" || matchesKey(data, Key.colon)) {
        if (!editor) {
          ctx.ui.notify("pi-vim editor is not available.", "warning");
          return { consume: true };
        }

        exDetour = true;
        exReturnArmed = false;
        setFocused(false);

        if (editor.getMode?.() !== "normal") editor.handleInput("\x1b");
        editor.handleInput(":");
        return { consume: true };
      }

      if (data === "j" || matchesKey(data, Key.down)) {
        tui?.scrollBy?.(1);
        return { consume: true };
      }

      if (data === "k" || matchesKey(data, Key.up)) {
        tui?.scrollBy?.(-1);
        return { consume: true };
      }

      if (
        data === "J" ||
        matchesKey(data, Key.shift("j")) ||
        matchesKey(data, Key.shift("down"))
      ) {
        selectPrompt(1);
        return { consume: true };
      }

      if (
        data === "K" ||
        matchesKey(data, Key.shift("k")) ||
        matchesKey(data, Key.shift("up"))
      ) {
        selectPrompt(-1);
        return { consume: true };
      }

      if (data === "b" || matchesKey(data, Key.pageUp)) {
        page(-1);
        return { consume: true };
      }

      if (data === "f" || matchesKey(data, Key.pageDown)) {
        page(1);
        return { consume: true };
      }

      if (data === "g" || matchesKey(data, Key.home)) {
        tui?.scrollToTop?.();
        return { consume: true };
      }

      if (data === "G" || matchesKey(data, Key.end)) {
        tui?.scrollToBottom?.();
        return { consume: true };
      }

      if (data === "y" || data === "c") {
        copySelectedPrompt();
        return { consume: true };
      }

      // While transcript mode owns focus, do not let unrecognised printable
      // input accidentally edit the prompt underneath it.
      return { consume: true };
    });
  });
}
