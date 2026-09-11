import {
  copyToClipboard,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  HStack,
  Key,
  VStack,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  stripTerminalSequences,
  type Component,
  type EditorComponent,
  type TUI,
} from "@earendil-works/pi-tui";

type PiVimEditor = EditorComponent & {
  getMode?: () => string;
  actionHandlers?: Map<string, () => void>;
};

type AppKeybindings = {
  matches?: (data: string, keybinding: string) => boolean;
};

type ClipboardWriter = (text: string) => Promise<void>;

type PrivateScrollView = Component & {
  scrollTop: number;
  viewportHeight: number;
  primary?: boolean;
  getContentWidth?: (width: number) => number;
  scrollTo?: (scrollTop: number, options?: { disableFollow?: boolean }) => void;
};

type FullscreenTui = TUI & {
  viewportTop?: number;
  scrollBy?: (lines: number) => void;
  scrollToTop?: () => void;
  scrollToBottom?: () => void;
  setLayoutRoot?: (component: Component | undefined) => void;
  // Both fields are private in TuiAltScreen's public type. Access is guarded and
  // limited to fullscreen transcript layout/viewport integration.
  layoutRoot?: Component;
  currentLayout?: {
    root?: { component: Component };
    primaryScrollView?: PrivateScrollView;
  };
};

type ComponentWithChildren = Component & {
  children?: Component[];
};

type PrivateStackEntry = {
  component: Component;
  basis?: number | "auto";
  grow?: number;
  shrink?: number;
  minSize?: number;
  maxSize?: number;
  visible?: (viewport: { width: number; height: number }) => boolean;
};

type PrivateStackLayoutNode = {
  type: "vstack" | "hstack";
  entries: PrivateStackEntry[];
  gap: number;
  align: "stretch" | "start" | "center" | "end";
};

type PrivateScrollLayoutNode = {
  type: "scroll";
  component: Component;
  state: PrivateScrollView;
};

type PrivateLayoutNode = PrivateStackLayoutNode | PrivateScrollLayoutNode;

type TranscriptItemKind =
  | "prompt"
  | "message"
  | "tool"
  | "bash"
  | "skill"
  | "summary"
  | "custom";

type TranscriptItem = {
  key: string;
  semanticKey: string;
  kind: TranscriptItemKind;
  component: Component;
  startRow: number;
  endRow: number;
  gutterStartRow: number;
  gutterEndRow: number;
  text: string;
};

type TranscriptLayoutInstallation = {
  originalRoot: Component;
  installedRoot: Component;
  scrollView: PrivateScrollView;
  gutter: TranscriptGutterComponent;
};

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const TRANSCRIPT_GUTTER_WIDTH = 1;
const PROMPT_SELECTION_MARKER = "\x1b[38;2;255;121;198m┃\x1b[39m";
const RESPONSE_SELECTION_MARKER = "\x1b[38;2;92;196;147m┃\x1b[39m";
const TRANSCRIPT_LAYOUT_ACTIONS = ["app.tools.expand", "app.thinking.toggle"] as const;

const TRANSCRIPT_COMPONENT_KINDS: Record<string, TranscriptItemKind> = {
  UserMessageComponent: "prompt",
  AssistantMessageComponent: "message",
  ToolExecutionComponent: "tool",
  BashExecutionComponent: "bash",
  SkillInvocationMessageComponent: "skill",
  CompactionSummaryMessageComponent: "summary",
  BranchSummaryMessageComponent: "summary",
  CustomMessageComponent: "custom",
  CustomEntryComponent: "custom",
};

function componentName(component: Component): string {
  return (component as { constructor?: { name?: string } }).constructor?.name ?? "";
}

function transcriptItemKind(component: Component): TranscriptItemKind | undefined {
  return TRANSCRIPT_COMPONENT_KINDS[componentName(component)];
}

function componentChildren(component: Component): Component[] {
  const children = (component as ComponentWithChildren).children;
  return Array.isArray(children) ? children : [];
}

function trimRenderedText(lines: string[]): string {
  const textLines = lines.map((line) => stripTerminalSequences(line).replace(/\s+$/u, ""));

  while (textLines.length > 0 && textLines[0].trim().length === 0) textLines.shift();
  while (textLines.length > 0 && textLines[textLines.length - 1].trim().length === 0) {
    textLines.pop();
  }

  const indents = textLines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^\s*/u)?.[0].length ?? 0);
  const commonIndent = indents.length > 0 ? Math.min(...indents) : 0;

  return textLines.map((line) => line.slice(commonIndent)).join("\n");
}

function visibleLineBounds(lines: string[]): { first: number; last: number } | undefined {
  let first = -1;
  let last = -1;

  for (let index = 0; index < lines.length; index++) {
    if (stripTerminalSequences(lines[index] ?? "").trim().length === 0) continue;
    if (first < 0) first = index;
    last = index;
  }

  return first < 0 ? undefined : { first, last };
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function semanticItemBaseKey(
  component: Component,
  kind: TranscriptItemKind,
  text: string,
): string {
  if (kind === "tool") {
    const toolCallId = (component as { toolCallId?: unknown }).toolCallId;
    if (typeof toolCallId === "string" && toolCallId.length > 0) return `tool:${toolCallId}`;
  }

  return `${kind}:${hashText(text)}`;
}

function privateLayoutNode(component: Component): PrivateLayoutNode | undefined {
  const getter = (component as unknown as Record<symbol, unknown>)[LAYOUT_NODE];
  return typeof getter === "function"
    ? (getter.call(component) as PrivateLayoutNode | undefined)
    : undefined;
}

class ScrollLayoutProxy implements Component {
  private readonly scrollView: PrivateScrollView;

  constructor(scrollView: PrivateScrollView) {
    this.scrollView = scrollView;
  }

  render(_width: number): string[] {
    // HStack measures child height before laying it out. Returning no legacy
    // lines avoids a second full transcript render; the delegated scroll layout
    // below still renders the real document exactly once through Pi's layout engine.
    return [];
  }

  invalidate(): void {
    this.scrollView.invalidate?.();
  }

  [LAYOUT_NODE](): PrivateLayoutNode | undefined {
    return privateLayoutNode(this.scrollView);
  }
}

class TranscriptGutterComponent implements Component {
  private selected:
    | { startRow: number; endRow: number; kind: TranscriptItemKind }
    | undefined;
  private readonly getScrollTop: () => number;
  private readonly getRenderRows: () => number;

  constructor(getScrollTop: () => number, getRenderRows: () => number) {
    this.getScrollTop = getScrollTop;
    this.getRenderRows = getRenderRows;
  }

  setSelection(item: TranscriptItem | undefined): void {
    this.selected = item
      ? {
          startRow: item.gutterStartRow,
          endRow: item.gutterEndRow,
          kind: item.kind,
        }
      : undefined;
  }

  render(_width: number): string[] {
    const rows = Math.max(1, this.getRenderRows());
    const lines = Array.from({ length: rows }, () => "");
    if (!this.selected) return lines;

    const top = this.getScrollTop();
    const first = Math.max(0, this.selected.startRow - top);
    const last = Math.min(rows, this.selected.endRow - top);
    if (first >= last) return lines;

    const marker =
      this.selected.kind === "prompt" ? PROMPT_SELECTION_MARKER : RESPONSE_SELECTION_MARKER;

    for (let row = first; row < last; row++) lines[row] = marker;
    return lines;
  }

  invalidate(): void {}
}

function findTranscriptContainer(
  component: Component,
  width: number,
  startRow = 0,
): { component: ComponentWithChildren; startRow: number } | undefined {
  const children = componentChildren(component);
  if (children.some((child) => transcriptItemKind(child) !== undefined)) {
    return { component: component as ComponentWithChildren, startRow };
  }

  let childRow = startRow;
  for (const child of children) {
    const found = findTranscriptContainer(child, width, childRow);
    if (found) return found;
    childRow += child.render(width).length;
  }

  return undefined;
}

function findMountedTranscriptContainer(
  roots: Component[],
  width: number,
): { component: ComponentWithChildren; startRow: number } | undefined {
  for (const root of roots) {
    const found = findTranscriptContainer(root, width, 0);
    if (found) return found;
  }

  // Pi mounts documentContainer as the first TUI child with
  // [headerContainer, loadedResourcesContainer, chatContainer]. During
  // session_start the chat container can still be empty, so semantic discovery
  // cannot find it yet. Use that stable mounted shape as a guarded fallback for
  // early transcript-item discovery.
  const document = roots[0];
  if (!document) return undefined;

  const documentChildren = componentChildren(document);
  const chat = documentChildren[2];
  if (!chat) return undefined;

  return {
    component: chat as ComponentWithChildren,
    startRow:
      (documentChildren[0]?.render(width).length ?? 0) +
      (documentChildren[1]?.render(width).length ?? 0),
  };
}

export default function transcriptFocus(
  pi: ExtensionAPI,
  writeClipboard: ClipboardWriter = copyToClipboard,
): void {
  let cleanupSession: (() => void) | undefined;
  let refreshActiveTranscript: (() => void) | undefined;

  const scheduleTranscriptRefresh = (): void => {
    setTimeout(() => refreshActiveTranscript?.(), 0);
  };

  pi.on("message_end", scheduleTranscriptRefresh);
  pi.on("tool_execution_end", scheduleTranscriptRefresh);

  pi.on("session_shutdown", () => {
    cleanupSession?.();
    cleanupSession = undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    cleanupSession?.();
    cleanupSession = undefined;

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
    let appKeybindings: AppKeybindings | undefined;
    let focused = false;
    let selectedKey: string | undefined;
    let selectedSemanticKey: string | undefined;
    let transcriptItemsCache: TranscriptItem[] | undefined;
    let transcriptLayout: TranscriptLayoutInstallation | undefined;
    const componentKeys = new WeakMap<object, string>();
    let nextComponentKey = 1;
    let exDetour = false;
    let exReturnArmed = false;
    let exReturnCheck: ReturnType<typeof setTimeout> | undefined;

    const activeScrollView = (): PrivateScrollView | undefined =>
      transcriptLayout?.scrollView ?? tui?.currentLayout?.primaryScrollView;

    const transcriptWidth = (): number => {
      if (!tui) return 1;
      const terminalWidth = Math.max(
        1,
        tui.terminal.columns - (transcriptLayout ? TRANSCRIPT_GUTTER_WIDTH : 0),
      );
      return activeScrollView()?.getContentWidth?.(terminalWidth) ?? terminalWidth;
    };

    const installTranscriptLayout = (): boolean => {
      if (!tui || tui.mode !== "fullscreen") return false;
      if (transcriptLayout) return true;
      if (!tui.setLayoutRoot) return false;

      const originalRoot = tui.currentLayout?.root?.component ?? tui.layoutRoot;
      if (!originalRoot) return false;

      const rootNode = privateLayoutNode(originalRoot);
      if (!rootNode || rootNode.type !== "vstack") return false;

      const currentPrimary = tui.currentLayout?.primaryScrollView;
      let transcriptIndex = -1;
      let scrollNode: PrivateScrollLayoutNode | undefined;

      for (let index = 0; index < rootNode.entries.length; index++) {
        const node = privateLayoutNode(rootNode.entries[index].component);
        if (!node || node.type !== "scroll") continue;
        if (currentPrimary && node.state !== currentPrimary) continue;
        if (!currentPrimary && !node.state.primary) continue;
        transcriptIndex = index;
        scrollNode = node;
        break;
      }

      if (transcriptIndex < 0 || !scrollNode) return false;

      const scrollView = scrollNode.state;
      const gutter = new TranscriptGutterComponent(
        () => scrollView.scrollTop,
        () => tui?.terminal.rows ?? 1,
      );
      const transcriptPane = new HStack(
        [
          {
            component: gutter,
            basis: TRANSCRIPT_GUTTER_WIDTH,
            grow: 0,
            shrink: 0,
            minSize: TRANSCRIPT_GUTTER_WIDTH,
            maxSize: TRANSCRIPT_GUTTER_WIDTH,
          },
          {
            component: new ScrollLayoutProxy(scrollView),
            basis: 0,
            grow: 1,
            shrink: 1,
            minSize: 1,
          },
        ],
        { align: "stretch" },
      );
      const rootEntries = rootNode.entries.map((entry, index) =>
        index === transcriptIndex ? { ...entry, component: transcriptPane } : { ...entry },
      );
      const installedRoot = new VStack(rootEntries, {
        gap: rootNode.gap,
        align: rootNode.align,
      });

      transcriptLayout = { originalRoot, installedRoot, scrollView, gutter };
      tui.setLayoutRoot(installedRoot);
      return true;
    };

    const restoreTranscriptLayout = (): void => {
      if (!transcriptLayout) return;
      const installation = transcriptLayout;
      transcriptLayout = undefined;

      if (tui?.setLayoutRoot) {
        const currentRoot = tui.currentLayout?.root?.component ?? tui.layoutRoot;
        if (!currentRoot || currentRoot === installation.installedRoot) {
          tui.setLayoutRoot(installation.originalRoot);
        }
      }
    };

    const componentKey = (component: Component, kind: TranscriptItemKind): string => {
      if (kind === "tool") {
        const toolCallId = (component as { toolCallId?: unknown }).toolCallId;
        if (typeof toolCallId === "string" && toolCallId.length > 0) return `tool:${toolCallId}`;
      }

      const object = component as object;
      let key = componentKeys.get(object);
      if (!key) {
        key = `${kind}:component:${nextComponentKey++}`;
        componentKeys.set(object, key);
      }
      return key;
    };

    const refreshTranscriptItems = (): TranscriptItem[] => {
      if (!tui) {
        transcriptItemsCache = [];
        return transcriptItemsCache;
      }

      const width = transcriptWidth();
      const transcript = findMountedTranscriptContainer(tui.children, width);

      if (!transcript) {
        transcriptLayout?.gutter.setSelection(undefined);
        transcriptItemsCache = [];
        return transcriptItemsCache;
      }

      const items: TranscriptItem[] = [];
      const duplicateKeys = new Map<string, number>();
      const renderedChildren: Array<{
        child: Component;
        kind: TranscriptItemKind | undefined;
        lines: string[];
        startRow: number;
      }> = [];
      let localRow = 0;

      for (const child of transcript.component.children ?? []) {
        const lines = child.render(width);
        renderedChildren.push({
          child,
          kind: transcriptItemKind(child),
          lines,
          startRow: localRow,
        });
        localRow += lines.length;
      }

      const transcriptLines = renderedChildren.flatMap(({ lines }) => lines);
      const isBlankLine = (line: string | undefined): boolean =>
        line !== undefined && stripTerminalSequences(line).trim().length === 0;

      for (const { child, kind, lines, startRow: childStartRow } of renderedChildren) {
        const bounds = kind ? visibleLineBounds(lines) : undefined;
        if (!kind || !bounds) continue;

        const text = trimRenderedText(lines);
        const baseKey = semanticItemBaseKey(child, kind, text);
        const occurrence = duplicateKeys.get(baseKey) ?? 0;
        duplicateKeys.set(baseKey, occurrence + 1);

        const visibleStartRow = childStartRow + bounds.first;
        const visibleEndRow = childStartRow + bounds.last + 1;
        const gutterStartRow =
          visibleStartRow > 0 && isBlankLine(transcriptLines[visibleStartRow - 1])
            ? visibleStartRow - 1
            : visibleStartRow;
        const gutterEndRow =
          visibleEndRow < transcriptLines.length && isBlankLine(transcriptLines[visibleEndRow])
            ? visibleEndRow + 1
            : visibleEndRow;

        items.push({
          key: componentKey(child, kind),
          semanticKey: `${baseKey}:${occurrence}`,
          kind,
          component: child,
          startRow: transcript.startRow + visibleStartRow,
          endRow: transcript.startRow + visibleEndRow,
          // Navigation stays anchored to visible content. The gutter absorbs at
          // most one adjacent blank transcript row above and below, regardless
          // of whether Pi owns that spacing inside or outside the component.
          gutterStartRow: transcript.startRow + gutterStartRow,
          gutterEndRow: transcript.startRow + gutterEndRow,
          text,
        });
      }

      transcriptItemsCache = items;
      return items;
    };

    const transcriptItems = (): TranscriptItem[] =>
      transcriptItemsCache ?? refreshTranscriptItems();

    const showSelection = (item: TranscriptItem): void => {
      transcriptLayout?.gutter.setSelection(item);
    };

    const hideSelectionDecoration = (): void => {
      transcriptLayout?.gutter.setSelection(undefined);
      tui?.requestRender();
    };

    const clearSelection = (): void => {
      selectedKey = undefined;
      selectedSemanticKey = undefined;
      hideSelectionDecoration();
    };

    const selectedItemFrom = (items: TranscriptItem[]): TranscriptItem | undefined => {
      if (!selectedKey && !selectedSemanticKey) return undefined;
      const item =
        items.find((candidate) => candidate.key === selectedKey) ??
        items.find((candidate) => candidate.semanticKey === selectedSemanticKey);
      if (!item) {
        selectedKey = undefined;
        selectedSemanticKey = undefined;
        transcriptLayout?.gutter.setSelection(undefined);
        return undefined;
      }

      selectedKey = item.key;
      selectedSemanticKey = item.semanticKey;
      if (focused || exDetour) showSelection(item);
      return item;
    };

    const refreshSelectionGeometry = (): void => {
      transcriptItemsCache = undefined;
      if (!focused && !exDetour) return;

      const items = refreshTranscriptItems();
      const selected = selectedItemFrom(items);
      if (selected) showSelection(selected);
      tui?.requestRender();
    };

    refreshActiveTranscript = refreshSelectionGeometry;

    const updateStatus = (): void => {
      if (!focused) {
        ctx.ui.setStatus("pi-tab-focus", undefined);
        return;
      }

      const items = transcriptItems();
      const selected = selectedItemFrom(items);
      const selectedIndex = selected ? items.indexOf(selected) : -1;
      const selection =
        selected && selectedIndex >= 0
          ? ` • ${selected.kind} ${selectedIndex + 1}/${items.length}`
          : "";

      ctx.ui.setStatus(
        "pi-tab-focus",
        `TRANSCRIPT ↑↓/jk scroll • u/d half-page • shift+↑↓/JK item • b/pgup up • f/pgdn down • c/y copy${selection} • : command • tab/esc exit`,
      );
    };

    const setFocused = (next: boolean): boolean => {
      if (next && tui?.mode !== "fullscreen") {
        focused = false;
        ctx.ui.setStatus("pi-tab-focus", undefined);
        ctx.ui.notify(
          "Transcript focus requires Pi fullscreen mode (--tui-mode fullscreen).",
          "warning",
        );
        return false;
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
      return true;
    };

    const leaveTranscriptMode = (): void => {
      // Keep the logical selection so re-entering transcript mode can restore it
      // if it is still visible. The reserved gutter remains part of transcript
      // layout; only the selection marker disappears while the editor owns focus.
      hideSelectionDecoration();
      setFocused(false);
    };

    const finishExDetour = (): void => {
      exDetour = false;
      exReturnArmed = false;
      if (exReturnCheck !== undefined) {
        clearTimeout(exReturnCheck);
        exReturnCheck = undefined;
      }
      setFocused(true);
      const items = refreshTranscriptItems();
      const selected = selectedItemFrom(items);
      if (selected) showSelection(selected);
      tui?.requestRender();
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

    const effectiveViewportHeight = (): number => {
      if (!tui) return 1;
      const viewportHeight = activeScrollView()?.viewportHeight;
      return viewportHeight && viewportHeight > 0
        ? viewportHeight
        : Math.max(1, tui.terminal.rows - 5);
    };

    const page = (direction: -1 | 1): void => {
      tui?.scrollBy?.(direction * effectiveViewportHeight());
    };

    const halfPage = (direction: -1 | 1): void => {
      tui?.scrollBy?.(direction * Math.max(1, Math.floor(effectiveViewportHeight() / 2)));
    };

    const revealItem = (item: TranscriptItem): void => {
      if (!tui) return;

      // Pi currently keeps the active layout frame private. When available, use
      // its primary ScrollView to reveal only as much as necessary. If that
      // implementation detail changes, fall back to moving the item to the top.
      const scrollView = activeScrollView();
      if (scrollView?.scrollTo && scrollView.viewportHeight > 0) {
        const viewportTop = scrollView.scrollTop;
        const viewportBottom = viewportTop + scrollView.viewportHeight;
        let target: number | undefined;

        if (item.startRow < viewportTop) {
          target = item.startRow;
        } else if (item.endRow > viewportBottom) {
          target =
            item.endRow - item.startRow > scrollView.viewportHeight
              ? item.startRow
              : item.endRow - scrollView.viewportHeight;
        }

        if (target !== undefined) {
          scrollView.scrollTo(target, { disableFollow: true });
          tui.requestRender();
        }
        return;
      }

      const viewportTop = tui.viewportTop ?? 0;
      tui.scrollBy?.(item.startRow - viewportTop);
    };

    const viewportBounds = (): { top: number; bottom: number } | undefined => {
      if (!tui) return undefined;

      const scrollView = activeScrollView();
      if (scrollView && scrollView.viewportHeight > 0) {
        return {
          top: scrollView.scrollTop,
          bottom: scrollView.scrollTop + scrollView.viewportHeight,
        };
      }

      const top = tui.viewportTop ?? 0;
      return {
        top,
        bottom: top + effectiveViewportHeight(),
      };
    };

    const itemIsVisible = (
      item: TranscriptItem,
      bounds: { top: number; bottom: number },
    ): boolean => item.endRow > bounds.top && item.startRow < bounds.bottom;

    const syncSelectionToViewport = (direction: -1 | 1): void => {
      let items = transcriptItems();
      const bounds = viewportBounds();
      if (items.length === 0 || !bounds) {
        clearSelection();
        updateStatus();
        return;
      }

      let current = selectedItemFrom(items);
      if (current && itemIsVisible(current, bounds)) return;

      // Item row ranges are expensive to calculate because Pi does not expose
      // them directly. Keep line scrolling on the cached snapshot and only
      // rebuild it when the current selection appears to leave the viewport.
      // This also refreshes rows changed by a streaming assistant/tool block.
      items = refreshTranscriptItems();
      current = selectedItemFrom(items);
      if (current && itemIsVisible(current, bounds)) return;

      const visibleItems = items.filter((item) => itemIsVisible(item, bounds));
      // Keep selection attached to the viewport edge it leaves through. When
      // scrolling up, the old selection falls out of the bottom, so choose the
      // bottom-most visible replacement. Scrolling down does the inverse.
      let next =
        direction < 0 ? visibleItems[visibleItems.length - 1] : visibleItems[0];

      // A viewport can theoretically land entirely in spacing between items.
      // Pick the nearest item at that same boundary rather than dropping
      // selection until the next scroll event.
      if (!next) {
        next =
          direction < 0
            ? [...items].reverse().find((item) => item.startRow < bounds.bottom) ?? items[0]
            : items.find((item) => item.endRow > bounds.top) ?? items[items.length - 1];
      }
      if (!next) return;

      selectedKey = next.key;
      selectedSemanticKey = next.semanticKey;
      showSelection(next);
      updateStatus();
      tui?.requestRender();
    };

    const enterTranscriptMode = (): void => {
      if (!setFocused(true)) return;

      const items = refreshTranscriptItems();
      const bounds = viewportBounds();
      if (items.length === 0 || !bounds) {
        clearSelection();
        updateStatus();
        return;
      }

      // Crush-like entry behavior is intentionally independent of scroll
      // direction: restore a previously selected visible item, otherwise choose
      // the bottom-most visible item (normally the newest visible transcript item).
      const current = selectedItemFrom(items);
      if (current && itemIsVisible(current, bounds)) {
        showSelection(current);
        updateStatus();
        tui?.requestRender();
        return;
      }

      const visibleItems = items.filter((item) => itemIsVisible(item, bounds));
      const next =
        visibleItems[visibleItems.length - 1] ??
        [...items].reverse().find((item) => item.startRow < bounds.bottom) ??
        items[items.length - 1];
      if (!next) return;

      selectedKey = next.key;
      selectedSemanticKey = next.semanticKey;
      showSelection(next);
      updateStatus();
      tui?.requestRender();
    };

    const selectItem = (direction: -1 | 1): void => {
      const items = refreshTranscriptItems();
      if (items.length === 0) {
        clearSelection();
        updateStatus();
        ctx.ui.notify("No selectable transcript items.", "info");
        return;
      }

      const current = selectedItemFrom(items);
      const currentIndex = current ? items.indexOf(current) : -1;
      const nextIndex =
        currentIndex < 0
          ? direction < 0
            ? items.length - 1
            : 0
          : Math.max(0, Math.min(items.length - 1, currentIndex + direction));
      const next = items[nextIndex];
      if (!next) return;

      selectedKey = next.key;
      selectedSemanticKey = next.semanticKey;
      showSelection(next);
      revealItem(next);
      updateStatus();
      tui?.requestRender();
    };

    const copySelectedItem = (): void => {
      const items = refreshTranscriptItems();
      if (items.length === 0) {
        ctx.ui.notify("No selectable transcript item.", "warning");
        return;
      }

      let selected = selectedItemFrom(items);
      if (!selected) {
        selected = items[items.length - 1];
        if (!selected) return;
        selectedKey = selected.key;
        selectedSemanticKey = selected.semanticKey;
        showSelection(selected);
        revealItem(selected);
        updateStatus();
      }

      const text = selected.text;
      const kind = selected.kind;

      void writeClipboard(text).then(
        () => ctx.ui.notify(`Copied selected ${kind}.`, "info"),
        (error: unknown) =>
          ctx.ui.notify(
            `Failed to copy selected ${kind}: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          ),
      );
    };

    // Preserve pi-vim's real ModalEditor/CustomEditor instance. Pi can therefore
    // see and wire its actionHandlers, onEscape, onCtrlD, image-paste handler,
    // extension shortcuts and any future CustomEditor surface directly.
    ctx.ui.setEditorComponent((nextTui, theme, keybindings) => {
      tui = nextTui as FullscreenTui;
      appKeybindings = keybindings as AppKeybindings;
      editor = previousFactory(nextTui, theme, keybindings) as PiVimEditor;

      // Install the gutter beside Pi's transcript ScrollView before initial
      // session messages are rendered. The transcript itself stays untouched;
      // scrolling therefore keeps Pi's normal render path and performance.
      if (tui.mode === "fullscreen" && installTranscriptLayout()) {
        refreshTranscriptItems();
      }

      return editor;
    });

    // Transcript focus is an input mode, not an editor implementation. Handle it
    // before input reaches pi-vim and consume only keys owned by transcript mode.
    const unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
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
        if (!isKeyRepeat(data)) {
          if (focused) leaveTranscriptMode();
          else enterTranscriptMode();
        }
        return { consume: true };
      }

      if (!focused) return undefined;

      if (matchesKey(data, Key.escape)) {
        leaveTranscriptMode();
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
        syncSelectionToViewport(1);
        return { consume: true };
      }

      if (data === "k" || matchesKey(data, Key.up)) {
        tui?.scrollBy?.(-1);
        syncSelectionToViewport(-1);
        return { consume: true };
      }

      if (data === "u") {
        halfPage(-1);
        syncSelectionToViewport(-1);
        return { consume: true };
      }

      if (data === "d") {
        halfPage(1);
        syncSelectionToViewport(1);
        return { consume: true };
      }

      const transcriptLayoutAction = TRANSCRIPT_LAYOUT_ACTIONS.find((action) =>
        appKeybindings?.matches?.(data, action),
      );
      if (transcriptLayoutAction) {
        if (!isKeyRepeat(data)) {
          const handler = editor?.actionHandlers?.get(transcriptLayoutAction);
          if (handler) handler();
          else editor?.handleInput(data);
          refreshSelectionGeometry();
        }
        return { consume: true };
      }

      if (
        data === "J" ||
        matchesKey(data, Key.shift("j")) ||
        matchesKey(data, Key.shift("down"))
      ) {
        selectItem(1);
        return { consume: true };
      }

      if (
        data === "K" ||
        matchesKey(data, Key.shift("k")) ||
        matchesKey(data, Key.shift("up"))
      ) {
        selectItem(-1);
        return { consume: true };
      }

      if (data === "b" || matchesKey(data, Key.pageUp)) {
        page(-1);
        syncSelectionToViewport(-1);
        return { consume: true };
      }

      if (data === "f" || matchesKey(data, Key.pageDown)) {
        page(1);
        syncSelectionToViewport(1);
        return { consume: true };
      }

      if (data === "g" || matchesKey(data, Key.home)) {
        tui?.scrollToTop?.();
        syncSelectionToViewport(-1);
        return { consume: true };
      }

      if (data === "G" || matchesKey(data, Key.end)) {
        tui?.scrollToBottom?.();
        syncSelectionToViewport(1);
        return { consume: true };
      }

      if (data === "y" || data === "c") {
        copySelectedItem();
        return { consume: true };
      }

      // While transcript mode owns focus, do not let unrecognised printable
      // input accidentally edit the prompt underneath it.
      return { consume: true };
    });

    cleanupSession = () => {
      unsubscribeTerminalInput();

      if (exReturnCheck !== undefined) {
        clearTimeout(exReturnCheck);
        exReturnCheck = undefined;
      }

      exDetour = false;
      exReturnArmed = false;
      clearSelection();
      transcriptItemsCache = undefined;
      restoreTranscriptLayout();
      if (refreshActiveTranscript === refreshSelectionGeometry) refreshActiveTranscript = undefined;

      ctx.ui.setStatus("pi-tab-focus", undefined);

      if (focused && tui && editor) tui.setFocus(editor);
      focused = false;
    };
  });
}
