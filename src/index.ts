import {
  CustomEditor,
  copyToClipboard,
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  HStack,
  Key,
  VStack,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  getOsc8LinkAtColumn,
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
  type Component,
  type EditorComponent,
  type TUI,
} from "@earendil-works/pi-tui";
import { resolveFocusKey } from "./focus-key-config.ts";
import {
  VimVisualNavigation,
  compareVimPoints,
  firstNonWhitespaceColumn,
  type VimCell,
  type VimPoint,
  type VimTextSource,
} from "./vim-navigation.ts";

type TranscriptEditor = EditorComponent & {
  getMode?: () => string;
  actionHandlers?: Map<string, () => void>;
};

type AppKeybindings = {
  matches?: (data: string, keybinding: string) => boolean;
};

type ClipboardWriter = (text: string) => Promise<void>;
type TextStyle = (text: string) => string;

type PrivateScrollView = Component & {
  scrollTop: number;
  viewportHeight: number;
  primary?: boolean;
  getContentWidth?: (width: number) => number;
  scrollTo?: (scrollTop: number, options?: { disableFollow?: boolean }) => void;
};

type NativeSelectionPoint = VimPoint & {
  scrollView?: PrivateScrollView;
  boundary?: boolean;
};

type NativeSelectionRange = {
  start: NativeSelectionPoint;
  end: NativeSelectionPoint;
};

type FullscreenTui = TUI & {
  viewportTop?: number;
  scrollBy?: (lines: number) => void;
  scrollToTop?: () => void;
  scrollToBottom?: () => void;
  setLayoutRoot?: (component: Component | undefined) => void;
  getFocusedComponent?: () => Component | null;
  // These fields are private in TuiAltScreen's public type. Access is guarded and
  // limited to fullscreen transcript layout/viewport integration.
  scrollToEndIndicator?: () => string;
  layoutRoot?: Component;
  currentLayout?: {
    root?: { component: Component };
    primaryScrollView?: PrivateScrollView;
  };
  selectionAnchor?: NativeSelectionPoint;
  selectionFocus?: NativeSelectionPoint;
  selectionGranularity?: "character" | "word" | "line";
  selectionInitialRange?: NativeSelectionRange;
  clearTextSelection?: () => void;
  getSelectionSourceLine?: (point: NativeSelectionPoint) => string;
  copyActiveSelectionToClipboard?: () => Promise<boolean>;
  openUrl?: (url: string) => void;
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
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
const LITERAL_URL_PATTERN = /(?:https?:\/\/|file:\/\/|mailto:)[^\s<>()]+/gu;
const TRANSCRIPT_GUTTER_WIDTH = 1;
const EDITOR_FOCUS_INDICATOR_WIDTH = 1;
const PROMPT_SELECTION_MARKER = "\x1b[38;2;255;121;198m┃\x1b[39m";
const RESPONSE_SELECTION_MARKER = "\x1b[38;2;92;196;147m┃\x1b[39m";
const TRANSCRIPT_LAYOUT_ACTIONS = [
  "app.tools.expand",
  "app.thinking.toggle",
] as const;

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
  return (
    (component as { constructor?: { name?: string } }).constructor?.name ?? ""
  );
}

function transcriptItemKind(
  component: Component,
): TranscriptItemKind | undefined {
  return TRANSCRIPT_COMPONENT_KINDS[componentName(component)];
}

function componentChildren(component: Component): Component[] {
  const children = (component as ComponentWithChildren).children;
  return Array.isArray(children) ? children : [];
}

function trimRenderedText(lines: string[]): string {
  const textLines = lines.map((line) =>
    stripTerminalSequences(line).replace(/\s+$/u, ""),
  );

  while (textLines.length > 0 && textLines[0].trim().length === 0)
    textLines.shift();
  while (
    textLines.length > 0 &&
    textLines[textLines.length - 1].trim().length === 0
  ) {
    textLines.pop();
  }

  const indents = textLines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^\s*/u)?.[0].length ?? 0);
  const commonIndent = indents.length > 0 ? Math.min(...indents) : 0;

  return textLines.map((line) => line.slice(commonIndent)).join("\n");
}

function visibleLineBounds(
  lines: string[],
): { first: number; last: number } | undefined {
  let first = -1;
  let last = -1;

  for (let index = 0; index < lines.length; index++) {
    if (stripTerminalSequences(lines[index] ?? "").trim().length === 0)
      continue;
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
    if (typeof toolCallId === "string" && toolCallId.length > 0)
      return `tool:${toolCallId}`;
  }

  return `${kind}:${hashText(text)}`;
}

function privateLayoutNode(
  component: Component,
): PrivateLayoutNode | undefined {
  // SAFETY: Pi stores private layout hooks under this symbol on component objects;
  // structural access is guarded by checking the value is callable before use.
  const getter = (component as unknown as Record<symbol, unknown>)[LAYOUT_NODE];
  return typeof getter === "function"
    ? (getter.call(component) as PrivateLayoutNode | undefined)
    : undefined;
}

class VisualCursorContentProxy implements Component {
  private readonly component: Component;
  private readonly getCursor: () => VimPoint | undefined;
  private readonly isSelecting: () => boolean;

  constructor(
    component: Component,
    getCursor: () => VimPoint | undefined,
    isSelecting: () => boolean,
  ) {
    this.component = component;
    this.getCursor = getCursor;
    this.isSelecting = isSelecting;
  }

  render(width: number): string[] {
    const lines = [...this.component.render(width)];
    const cursor = this.getCursor();
    if (!cursor || this.isSelecting()) return lines;

    const line = lines[cursor.row] ?? "";
    const lineWidth = visibleWidth(line);
    const col = Math.max(0, Math.min(cursor.col, lineWidth));
    const before = sliceByColumn(line, 0, col, true);
    const atCursor =
      col >= lineWidth
        ? " "
        : sliceByColumn(
          line,
          col,
          Math.max(1, visibleWidth(sliceByColumn(line, col, 1, true))),
          true,
        );
    const after = sliceByColumn(
      line,
      col + visibleWidth(atCursor),
      Math.max(0, lineWidth - col - visibleWidth(atCursor)),
      true,
    );
    lines[cursor.row] =
      `${before}${CURSOR_MARKER}\x1b[7m${atCursor}\x1b[27m${after}`;
    return lines;
  }

  invalidate(): void {
    this.component.invalidate?.();
  }
}

class ScrollLayoutProxy implements Component {
  private readonly scrollView: PrivateScrollView;
  private readonly getCursor: () => VimPoint | undefined;
  private readonly isSelecting: () => boolean;

  constructor(
    scrollView: PrivateScrollView,
    getCursor: () => VimPoint | undefined,
    isSelecting: () => boolean,
  ) {
    this.scrollView = scrollView;
    this.getCursor = getCursor;
    this.isSelecting = isSelecting;
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
    const node = privateLayoutNode(this.scrollView);
    if (!node || node.type !== "scroll") return node;
    return {
      ...node,
      component: new VisualCursorContentProxy(
        node.component,
        this.getCursor,
        this.isSelecting,
      ),
    };
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
      this.selected.kind === "prompt"
        ? PROMPT_SELECTION_MARKER
        : RESPONSE_SELECTION_MARKER;

    for (let row = first; row < last; row++) lines[row] = marker;
    return lines;
  }

  invalidate(): void { }
}

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

  invalidate(): void { }
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
  agentDir: string = getAgentDir(),
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

    const {
      key: focusKey,
      hideDefaultScrollIndicator,
      warnings: focusConfigWarnings,
    } = resolveFocusKey(ctx, agentDir);
    for (const warning of focusConfigWarnings) ctx.ui.notify(warning, "warning");

    const previousFactory = ctx.ui.getEditorComponent();

    let tui: FullscreenTui | undefined;
    let editor: TranscriptEditor | undefined;
    let appKeybindings: AppKeybindings | undefined;
    let focused = false;
    let selectedKey: string | undefined;
    let selectedSemanticKey: string | undefined;
    let transcriptItemsCache: TranscriptItem[] | undefined;
    let transcriptContentHeight: number | undefined;
    let transcriptLayout: TranscriptLayoutInstallation | undefined;
    let scrollIndicatorOverride:
      | { tui: FullscreenTui; render: (() => string) | undefined }
      | undefined;
    let visualSourceRevision = 0;
    const visualLineCache = new Map<number, VimCell[]>();
    const componentKeys = new WeakMap<object, string>();
    let nextComponentKey = 1;
    let exDetour = false;
    let exReturnArmed = false;
    let exReturnCheck: ReturnType<typeof setTimeout> | undefined;
    let visualNavigation: VimVisualNavigation | undefined;
    let visualWidth: number | undefined;

    const activeScrollView = (): PrivateScrollView | undefined =>
      transcriptLayout?.scrollView ?? tui?.currentLayout?.primaryScrollView;

    const inVisualMode = (): boolean => Boolean(visualNavigation);
    const isVisualSelecting = (): boolean =>
      visualNavigation?.isSelecting() ?? false;
    const visualSnapshot = () => visualNavigation?.snapshot();
    const supportsExCommands = (): boolean =>
      typeof editor?.getMode === "function";
    const matchesFocusKey = (data: string): boolean => matchesKey(data, focusKey);

    const transientUiHasFocus = (): boolean => {
      const active = tui?.getFocusedComponent?.();
      return active !== undefined && active !== null && active !== editor;
    };

    const reclaimTranscriptFocus = (): void => {
      if (focused && tui?.getFocusedComponent?.() === editor) tui?.setFocus(null);
    };

    const transcriptWidth = (): number => {
      if (!tui) return 1;
      const terminalWidth = Math.max(
        1,
        tui.terminal.columns - (transcriptLayout ? TRANSCRIPT_GUTTER_WIDTH : 0),
      );
      return (
        activeScrollView()?.getContentWidth?.(terminalWidth) ?? terminalWidth
      );
    };

    const nativeSelectionPoint = (point: VimPoint): NativeSelectionPoint => ({
      ...point,
      scrollView: activeScrollView(),
    });

    const sourceLine = (row: number): string =>
      tui?.getSelectionSourceLine?.(nativeSelectionPoint({ row, col: 0 })) ?? "";

    const graphemeColumns = (line: string): VimCell[] => {
      const stripped = stripTerminalSequences(line);
      const columns: VimCell[] = [];
      let col = 0;

      for (const segment of GRAPHEME_SEGMENTER.segment(stripped)) {
        const width = Math.max(0, visibleWidth(segment.segment));
        columns.push({ start: col, end: col + width, text: segment.segment });
        col += width;
      }

      return columns;
    };

    const clampRow = (row: number): number =>
      transcriptContentHeight
        ? Math.max(0, Math.min(transcriptContentHeight - 1, row))
        : Math.max(0, row);

    const visualTextSource: VimTextSource = {
      get lineCount() {
        return Math.max(1, transcriptContentHeight ?? 1);
      },
      get revision() {
        return visualSourceRevision;
      },
      line: (row) => {
        const clamped = clampRow(row);
        const cached = visualLineCache.get(clamped);
        if (cached) return cached;
        const cells = graphemeColumns(sourceLine(clamped));
        visualLineCache.set(clamped, cells);
        return cells;
      },
    };

    const invalidateVisualSource = (): void => {
      visualSourceRevision++;
      visualLineCache.clear();
    };

    const graphemeEndPoint = (point: VimPoint): NativeSelectionPoint => {
      const cells = visualTextSource.line(point.row);
      const grapheme =
        cells.find(
          (candidate) =>
            point.col >= candidate.start && point.col < candidate.end,
        ) ??
        cells.find((candidate) => candidate.start >= point.col) ??
        cells[cells.length - 1];
      return {
        row: point.row,
        col: grapheme?.end ?? point.col,
        scrollView: activeScrollView(),
        boundary: true,
      };
    };

    const lineSelectionRange = (point: VimPoint): NativeSelectionRange => {
      const cells = visualTextSource.line(point.row);
      return {
        start: nativeSelectionPoint({ row: point.row, col: 0 }),
        end: {
          row: point.row,
          col: cells[cells.length - 1]?.end ?? 0,
          scrollView: activeScrollView(),
          boundary: true,
        },
      };
    };

    const hidePiScrollIndicator = (): void => {
      if (
        !tui ||
        tui.mode !== "fullscreen" ||
        !hideDefaultScrollIndicator ||
        scrollIndicatorOverride
      ) {
        return;
      }

      scrollIndicatorOverride = {
        tui,
        render: tui.scrollToEndIndicator,
      };
      tui.scrollToEndIndicator = undefined;
    };

    const restorePiScrollIndicator = (): void => {
      if (!scrollIndicatorOverride) return;
      scrollIndicatorOverride.tui.scrollToEndIndicator =
        scrollIndicatorOverride.render;
      scrollIndicatorOverride = undefined;
    };

    const installTranscriptLayout = (
      activeIndicatorStyle: TextStyle,
      inactiveIndicatorStyle: TextStyle,
    ): boolean => {
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
            component: new ScrollLayoutProxy(
              scrollView,
              () => visualSnapshot()?.head,
              () => isVisualSelecting(),
            ),
            basis: 0,
            grow: 1,
            shrink: 1,
            minSize: 1,
          },
        ],
        { align: "stretch" },
      );
      // Pi's fullscreen root is transcript + fixed input dock. Keep this guarded
      // to the first non-transcript sibling so a future layout shape degrades to
      // transcript-only decoration rather than guessing at nested components.
      const dockIndex = rootNode.entries.findIndex(
        (_entry, index) => index !== transcriptIndex,
      );
      const editorFocusIndicator = new EditorFocusIndicatorComponent(
        () => tui?.getFocusedComponent?.() === editor,
        activeIndicatorStyle,
        inactiveIndicatorStyle,
      );
      const dockPane =
        dockIndex >= 0
          ? new HStack(
            [
              {
                component: editorFocusIndicator,
                basis: EDITOR_FOCUS_INDICATOR_WIDTH,
                grow: 0,
                shrink: 0,
                minSize: EDITOR_FOCUS_INDICATOR_WIDTH,
                maxSize: EDITOR_FOCUS_INDICATOR_WIDTH,
              },
              {
                component: rootNode.entries[dockIndex].component,
                basis: 0,
                grow: 1,
                shrink: 1,
                minSize: 1,
              },
            ],
            { align: "stretch" },
          )
          : undefined;
      const rootEntries = rootNode.entries.map((entry, index) => {
        if (index === transcriptIndex)
          return { ...entry, component: transcriptPane };
        if (index === dockIndex && dockPane)
          return { ...entry, component: dockPane };
        return { ...entry };
      });
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
        const currentRoot =
          tui.currentLayout?.root?.component ?? tui.layoutRoot;
        if (!currentRoot || currentRoot === installation.installedRoot) {
          tui.setLayoutRoot(installation.originalRoot);
        }
      }
    };

    const componentKey = (
      component: Component,
      kind: TranscriptItemKind,
    ): string => {
      if (kind === "tool") {
        const toolCallId = (component as { toolCallId?: unknown }).toolCallId;
        if (typeof toolCallId === "string" && toolCallId.length > 0)
          return `tool:${toolCallId}`;
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
      invalidateVisualSource();
      if (!tui) {
        transcriptContentHeight = undefined;
        transcriptItemsCache = [];
        return transcriptItemsCache;
      }

      const width = transcriptWidth();
      const transcript = findMountedTranscriptContainer(tui.children, width);

      if (!transcript) {
        transcriptContentHeight = undefined;
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

      transcriptContentHeight = localRow + transcript.startRow;

      const transcriptLines = renderedChildren.flatMap(({ lines }) => lines);
      const isBlankLine = (line: string | undefined): boolean =>
        line !== undefined && stripTerminalSequences(line).trim().length === 0;

      for (const {
        child,
        kind,
        lines,
        startRow: childStartRow,
      } of renderedChildren) {
        const bounds = kind ? visibleLineBounds(lines) : undefined;
        if (!kind || !bounds) continue;

        const text = trimRenderedText(lines);
        const baseKey = semanticItemBaseKey(child, kind, text);
        const occurrence = duplicateKeys.get(baseKey) ?? 0;
        duplicateKeys.set(baseKey, occurrence + 1);

        const visibleStartRow = childStartRow + bounds.first;
        const visibleEndRow = childStartRow + bounds.last + 1;
        const gutterStartRow =
          visibleStartRow > 0 &&
            isBlankLine(transcriptLines[visibleStartRow - 1])
            ? visibleStartRow - 1
            : visibleStartRow;
        const gutterEndRow =
          visibleEndRow < transcriptLines.length &&
            isBlankLine(transcriptLines[visibleEndRow])
            ? visibleEndRow + 1
            : visibleEndRow;

        items.push({
          key: componentKey(child, kind),
          semanticKey: `${baseKey}:${occurrence}`,
          kind,
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

    const selectedItemFrom = (
      items: TranscriptItem[],
    ): TranscriptItem | undefined => {
      if (!selectedKey && !selectedSemanticKey) return undefined;
      const item =
        items.find((candidate) => candidate.key === selectedKey) ??
        items.find(
          (candidate) => candidate.semanticKey === selectedSemanticKey,
        );
      if (!item) {
        selectedKey = undefined;
        selectedSemanticKey = undefined;
        transcriptLayout?.gutter.setSelection(undefined);
        return undefined;
      }

      selectedKey = item.key;
      selectedSemanticKey = item.semanticKey;
      if ((focused || exDetour) && !inVisualMode()) showSelection(item);
      return item;
    };

    const clearNativeTextSelection = (): void => {
      tui?.clearTextSelection?.();
      if (tui) {
        tui.selectionAnchor = undefined;
        tui.selectionFocus = undefined;
        tui.selectionInitialRange = undefined;
        tui.selectionGranularity = "character";
      }
    };

    const applyVisualSelection = (): void => {
      const visual = visualSnapshot();
      if (!tui || !visual?.anchor || !visual.selectionKind) {
        clearNativeTextSelection();
        return;
      }

      const { anchor, head, selectionKind } = visual;
      if (selectionKind === "line") {
        const anchorRange = lineSelectionRange(anchor);
        const headRange = lineSelectionRange(head);
        const headBeforeAnchor = head.row < anchor.row;
        tui.selectionGranularity = "line";
        tui.selectionInitialRange = anchorRange;
        tui.selectionAnchor = headBeforeAnchor ? anchorRange.end : anchorRange.start;
        tui.selectionFocus = headBeforeAnchor ? headRange.start : headRange.end;
      } else {
        const anchorBeforeHead = compareVimPoints(anchor, head) <= 0;
        tui.selectionGranularity = "character";
        tui.selectionInitialRange = undefined;
        tui.selectionAnchor = anchorBeforeHead
          ? nativeSelectionPoint(anchor)
          : nativeSelectionPoint(head);
        tui.selectionFocus = anchorBeforeHead
          ? graphemeEndPoint(head)
          : graphemeEndPoint(anchor);
      }

      transcriptLayout?.gutter.setSelection(undefined);
      tui.requestRender();
    };

    const syncSelectionToVisualHead = (direction: -1 | 1): void => {
      const head = visualSnapshot()?.head;
      if (!head) return;
      const items = transcriptItems();
      const row = head.row;
      const direct = items.find(
        (item) => row >= item.startRow && row < item.endRow,
      );
      const adjacent =
        direction >= 0
          ? (items.find((item) => item.startRow >= row) ??
            items[items.length - 1])
          : (items.toReversed().find((item) => item.endRow <= row) ?? items[0]);
      const next = direct ?? adjacent;
      if (!next) return;
      selectedKey = next.key;
      selectedSemanticKey = next.semanticKey;
    };

    const revealVisualHead = (): void => {
      const head = visualSnapshot()?.head;
      if (!tui || !head) return;
      const scrollView = activeScrollView();
      if (scrollView?.scrollTo && scrollView.viewportHeight > 0) {
        const top = scrollView.scrollTop;
        const bottom = top + scrollView.viewportHeight;
        let target: number | undefined;
        if (head.row < top) target = head.row;
        else if (head.row >= bottom)
          target = head.row - scrollView.viewportHeight + 1;
        if (target !== undefined)
          scrollView.scrollTo(Math.max(0, target), { disableFollow: true });
      } else {
        const top = tui.viewportTop ?? 0;
        if (head.row < top || head.row >= top + effectiveViewportHeight()) {
          tui.scrollBy?.(head.row - top);
        }
      }
    };

    const finishVisualMode = (
      options: { restoreGutter: boolean } = { restoreGutter: true },
    ): void => {
      const head = visualSnapshot()?.head;
      if (options.restoreGutter && head) syncSelectionToVisualHead(1);
      visualNavigation = undefined;
      visualWidth = undefined;
      clearNativeTextSelection();
      if (options.restoreGutter) {
        const selected = selectedItemFrom(transcriptItems());
        if (selected && focused) showSelection(selected);
      } else {
        transcriptLayout?.gutter.setSelection(undefined);
      }
      updateStatus();
      tui?.requestRender();
    };

    const refreshSelectionGeometry = (): void => {
      transcriptItemsCache = undefined;
      if (!focused && !exDetour) return;

      const items = refreshTranscriptItems();
      const selected = selectedItemFrom(items);
      visualNavigation?.clamp(visualTextSource);
      if (isVisualSelecting()) applyVisualSelection();
      else if (!inVisualMode() && selected) showSelection(selected);
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
      const visual = visualSnapshot();
      const pending = visual?.pending ? ` • ${visual.pending}` : "";
      const exHint = supportsExCommands() ? " • : command" : "";

      ctx.ui.setStatus(
        "pi-tab-focus",
        visual
          ? visual.selectionKind === "line"
            ? `VISUAL LINE hjkl/wbe/WBE • fFtT • gg/G • y/c copy • esc/v cursor${pending}${selection}`
            : visual.selectionKind
              ? `VISUAL SELECT hjkl/wbe/WBE • iw/aw + quotes/brackets • fFtT • y/c copy • esc/v cursor${pending}${selection}`
              : `VISUAL NAV hjkl/wbe/WBE • fFtT • gg/G • v select • V line • iw/aw objects • esc exit${pending}${selection}`
          : `TRANSCRIPT ↑↓/jk scroll • u/d half-page • shift+↑↓/JK item • b/pgup up • f/pgdn down • c/y copy${selection} • v visual • V line • enter link${exHint} • ${focusKey}/esc exit`,
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
      // Removing focus from the editor suppresses its CURSOR_MARKER, so Pi hides
      // the hardware caret while scrolling the transcript. This avoids cursor
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
      if (inVisualMode()) {
        visualNavigation?.clamp(visualTextSource);
        if (isVisualSelecting()) applyVisualSelection();
        else transcriptLayout?.gutter.setSelection(undefined);
      } else if (selected) {
        showSelection(selected);
      }
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
        if (!tui.hasOverlay() && tui.getFocusedComponent?.() === editor) {
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
      tui?.scrollBy?.(
        direction * Math.max(1, Math.floor(effectiveViewportHeight() / 2)),
      );
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
            ? (items
              .toReversed()
              .find((item) => item.startRow < bounds.bottom) ?? items[0])
            : (items.find((item) => item.endRow > bounds.top) ??
              items[items.length - 1]);
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
        items.toReversed().find((item) => item.startRow < bounds.bottom) ??
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

    const ensureVisualWidth = (): boolean => {
      if (!inVisualMode()) return true;
      if (visualWidth === transcriptWidth()) return true;
      finishVisualMode();
      return false;
    };

    const selectedVisualStartPoint = (): VimPoint | undefined => {
      const items = refreshTranscriptItems();
      const selected = selectedItemFrom(items) ?? items[items.length - 1];
      if (!selected) {
        ctx.ui.notify("No selectable transcript item.", "warning");
        return undefined;
      }
      selectedKey = selected.key;
      selectedSemanticKey = selected.semanticKey;
      const row = clampRow(selected.startRow);
      return {
        row,
        col: firstNonWhitespaceColumn(visualTextSource, row),
      };
    };

    const enterVisualMode = (): void => {
      const point = selectedVisualStartPoint();
      if (!point) return;
      visualNavigation = new VimVisualNavigation(point);
      visualWidth = transcriptWidth();
      hideSelectionDecoration();
      clearNativeTextSelection();
      revealVisualHead();
      updateStatus();
      tui?.requestRender();
    };

    const syncVisualNavigation = (before: VimPoint): void => {
      const after = visualSnapshot()?.head;
      if (!after) return;
      const comparison = compareVimPoints(after, before);
      if (comparison !== 0) {
        syncSelectionToVisualHead(comparison > 0 ? 1 : -1);
        revealVisualHead();
      }
      if (isVisualSelecting()) applyVisualSelection();
      else clearNativeTextSelection();
      updateStatus();
      tui?.requestRender();
    };

    const copyVisualSelection = (): void => {
      if (!isVisualSelecting()) {
        ctx.ui.notify("Press v or V to start a selection.", "info");
        return;
      }
      void tui?.copyActiveSelectionToClipboard?.().then(
        (ok) =>
          ctx.ui.notify(
            ok ? "Copied selected text." : "No text selection to copy.",
            ok ? "info" : "warning",
          ),
        (error: unknown) =>
          ctx.ui.notify(
            `Failed to copy selection: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          ),
      );
      finishVisualMode();
    };

    const literalUrlAtColumn = (
      line: string,
      col: number,
    ): string | undefined => {
      const stripped = stripTerminalSequences(line);
      for (const match of stripped.matchAll(LITERAL_URL_PATTERN)) {
        const text = match[0];
        const start = visibleWidth(stripped.slice(0, match.index));
        const end = start + visibleWidth(text);
        if (col >= start && col < end) return text;
      }
      return undefined;
    };

    const firstLiteralUrl = (text: string): string | undefined =>
      text.match(LITERAL_URL_PATTERN)?.[0];

    const openSelectedLink = (): void => {
      let url: string | undefined;
      const head = visualSnapshot()?.head;
      if (head) {
        const line = sourceLine(head.row);
        url =
          getOsc8LinkAtColumn(line, head.col) ??
          literalUrlAtColumn(line, head.col);
      }
      if (!url) {
        const selected = selectedItemFrom(transcriptItems());
        if (selected) url = firstLiteralUrl(selected.text);
      }
      if (!url) {
        ctx.ui.notify("No link found in selected transcript item.", "info");
        return;
      }
      try {
        tui?.openUrl?.(url);
      } catch {
        ctx.ui.notify(`Failed to open link: ${url}`, "error");
      }
    };

    const enterExDetour = (): void => {
      if (!editor?.getMode) {
        ctx.ui.notify("EX commands require pi-vim.", "info");
        return;
      }

      exDetour = true;
      exReturnArmed = false;
      setFocused(false);

      if (editor.getMode() !== "normal") editor.handleInput("\x1b");
      editor.handleInput(":");
    };

    const normalizeVisualKey = (data: string): string => {
      if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+["))
        return "escape";
      if (matchesKey(data, Key.enter)) return "enter";
      if (matchesKey(data, Key.left)) return "h";
      if (matchesKey(data, Key.right)) return "l";
      if (matchesKey(data, Key.up)) return "k";
      if (matchesKey(data, Key.down)) return "j";
      if (data === ":" || matchesKey(data, Key.colon)) return ":";
      return data;
    };

    const handleVisualInput = (data: string): boolean => {
      if (!visualNavigation || !ensureVisualWidth()) return false;

      const before = visualNavigation.snapshot().head;
      const result = visualNavigation.handleKey(
        normalizeVisualKey(data),
        visualTextSource,
      );
      if (!result.handled) {
        updateStatus();
        return false;
      }

      if (result.command === "copy") copyVisualSelection();
      else if (result.command === "open-link") {
        openSelectedLink();
        updateStatus();
      } else if (result.command === "ex") enterExDetour();
      else if (result.command === "exit") finishVisualMode();
      else syncVisualNavigation(before);

      return true;
    };

    // Preserve any existing custom editor (including pi-vim). When Pi is using
    // its built-in editor, install an equivalent CustomEditor so this extension
    // can receive the TUI/keybinding objects without requiring another package.
    // Pi wires default editor callbacks, app actions, paste handling and extension
    // shortcuts onto returned CustomEditor instances.
    ctx.ui.setEditorComponent((nextTui, theme, keybindings) => {
      tui = nextTui as FullscreenTui;
      appKeybindings = keybindings as AppKeybindings;
      editor = (previousFactory
        ? previousFactory(nextTui, theme, keybindings)
        : new CustomEditor(nextTui, theme, keybindings, {
          embedWorkingStatus: true,
        })) as TranscriptEditor;

      // Install the transcript gutter and editor-focus indicator before initial
      // session messages are rendered. The transcript/editor components stay
      // untouched; only Pi's fullscreen layout is composed around them.
      if (tui.mode === "fullscreen") {
        hidePiScrollIndicator();
        if (
          installTranscriptLayout(
            theme.selectList.selectedPrefix,
            theme.borderColor,
          )
        ) {
          refreshTranscriptItems();
        }
      }

      return editor;
    });

    // Transcript focus is an input mode, not an editor implementation. Handle it
    // before input reaches the editor and consume only keys owned by transcript mode.
    const unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
      // When another Pi/custom component has actual TUI focus, it owns input.
      // This covers select/confirm/input/editor prompts and capturing overlays.
      if (transientUiHasFocus()) {
        if (exDetour) checkExReturnAfterInput();
        return undefined;
      }

      // Pi restores editor focus when a transient component closes. Transcript
      // mode is logically still active, so reclaim its normal null-focus state.
      if (!exDetour) reclaimTranscriptFocus();


      // Raw input listeners run before Pi filters key-release events.
      if (isKeyRelease(data)) return undefined;

      // When pi-vim is present, `:` is a temporary detour into its EX mini-mode.
      // While it is active, let the editor/Pi own input normally. Enter or Escape
      // ends EX input; if the command opens an overlay, subsequent overlay input
      // keeps checking until Pi restores focus to the editor, then transcript
      // mode resumes.
      if (exDetour) {
        // The configured focus key keeps its transcript-focus meaning while the
        // EX mini-mode is active. Cancel EX and return to transcript navigation.
        if (matchesFocusKey(data)) {
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

      if (matchesFocusKey(data)) {
        // Holding the focus key must not repeatedly flip focus on key-repeat events.
        if (!isKeyRepeat(data)) {
          if (inVisualMode()) finishVisualMode({ restoreGutter: false });
          if (focused) leaveTranscriptMode();
          else enterTranscriptMode();
        }
        return { consume: true };
      }

      if (!focused) return undefined;

      const transcriptLayoutAction = TRANSCRIPT_LAYOUT_ACTIONS.find((action) =>
        appKeybindings?.matches?.(data, action),
      );
      if (transcriptLayoutAction) {
        if (!isKeyRepeat(data)) {
          if (inVisualMode()) finishVisualMode();
          const handler = editor?.actionHandlers?.get(transcriptLayoutAction);
          if (handler) handler();
          else editor?.handleInput(data);
          refreshSelectionGeometry();
        }
        return { consume: true };
      }

      if (matchesKey(data, "ctrl+d")) {
        ctx.shutdown();
        return { consume: true };
      }

      // Leave transcript focus on Ctrl+C; once the editor owns focus again,
      // subsequent Ctrl+C input follows Pi's normal handling.
      if (matchesKey(data, "ctrl+c")) {
        if (inVisualMode()) finishVisualMode({ restoreGutter: false });
        leaveTranscriptMode();
        return { consume: true };
      }

      if (inVisualMode()) {
        return handleVisualInput(data) ? { consume: true } : undefined;
      }

      if (matchesKey(data, Key.escape)) {
        leaveTranscriptMode();
        return { consume: true };
      }

      if (data === "v") {
        enterVisualMode();
        return { consume: true };
      }

      if (data === "V") {
        enterVisualMode();
        if (inVisualMode()) handleVisualInput("V");
        return { consume: true };
      }

      if (matchesKey(data, Key.enter)) {
        openSelectedLink();
        return { consume: true };
      }

      if (data === ":" || matchesKey(data, Key.colon)) {
        enterExDetour();
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

      // Transcript mode keeps TUI focus at null, so unrecognised input cannot
      // edit the prompt editor. Leave it unconsumed so other extensions' raw
      // terminal-input listeners can handle their own shortcuts.
      return undefined;
    });

    cleanupSession = () => {
      unsubscribeTerminalInput();

      if (exReturnCheck !== undefined) {
        clearTimeout(exReturnCheck);
        exReturnCheck = undefined;
      }

      exDetour = false;
      exReturnArmed = false;
      if (inVisualMode()) finishVisualMode({ restoreGutter: false });
      clearSelection();
      transcriptItemsCache = undefined;
      transcriptContentHeight = undefined;
      restoreTranscriptLayout();
      restorePiScrollIndicator();
      if (focused && tui && editor) tui.setFocus(editor);
      ctx.ui.setEditorComponent(previousFactory);
      if (refreshActiveTranscript === refreshSelectionGeometry)
        refreshActiveTranscript = undefined;

      ctx.ui.setStatus("pi-tab-focus", undefined);
      focused = false;
    };
  });
}
