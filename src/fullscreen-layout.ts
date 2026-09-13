import {
  HStack,
  VStack,
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { suppressDefaultScrollIndicator } from "./fullscreen-ui.ts";
import type { VimPoint } from "./vim-navigation.ts";

export type PrivateScrollView = Component & {
  scrollTop: number;
  viewportHeight: number;
  contentHeight?: number;
  primary?: boolean;
  getContentWidth?: (width: number) => number;
  scrollTo?: (scrollTop: number, options?: { disableFollow?: boolean }) => void;
};

export type NativeSelectionPoint = VimPoint & {
  scrollView?: PrivateScrollView;
  boundary?: boolean;
};

export type NativeSelectionRange = {
  start: NativeSelectionPoint;
  end: NativeSelectionPoint;
};

export type FullscreenTui = TUI & {
  viewportTop?: number;
  scrollBy?: (lines: number) => void;
  scrollToTop?: () => void;
  scrollToBottom?: () => void;
  setLayoutRoot?: (component: Component | undefined) => void;
  getFocusedComponent?: () => Component | null;
  // These fields are private in TuiAltScreen's public type. Access is guarded and
  // limited to fullscreen transcript layout/viewport integration.
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

export type TranscriptGutterSelection = {
  gutterStartRow: number;
  gutterEndRow: number;
  kind: string;
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

type TranscriptLayoutInstallation = {
  originalRoot: Component;
  installedRoot: Component;
  scrollView: PrivateScrollView;
  gutter: TranscriptGutterComponent;
  rendererChildren: Component[];
};

type FullscreenLayoutControllerOptions = {
  getTui: () => FullscreenTui | undefined;
  getCursor: () => VimPoint | undefined;
  isSelecting: () => boolean;
  hideDefaultScrollIndicator: boolean;
  onIntegrationInvalidated?: () => void;
};

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
const TRANSCRIPT_GUTTER_WIDTH = 1;
const PROMPT_SELECTION_MARKER = "\x1b[38;2;255;121;198m┃\x1b[39m";
const RESPONSE_SELECTION_MARKER = "\x1b[38;2;92;196;147m┃\x1b[39m";

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

function graphemeWidthAtColumn(line: string, col: number): number {
  const stripped = stripTerminalSequences(line);
  let currentCol = 0;

  for (const { segment } of GRAPHEME_SEGMENTER.segment(stripped)) {
    const width = Math.max(0, visibleWidth(segment));
    if (width > 0 && col >= currentCol && col < currentCol + width) return width;
    currentCol += width;
  }

  return 1;
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
    const cursorWidth =
      col >= lineWidth ? 1 : graphemeWidthAtColumn(line, col);
    const atCursor =
      col >= lineWidth
        ? " "
        : sliceByColumn(line, col, cursorWidth, false) || " ";
    const after = sliceByColumn(
      line,
      col + cursorWidth,
      Math.max(0, lineWidth - col - cursorWidth),
      true,
    );
    lines[cursor.row] = `${before}\x1b[7m${atCursor}\x1b[27m${after}`;
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
    | { startRow: number; endRow: number; kind: string }
    | undefined;
  private readonly getScrollTop: () => number;
  private readonly getRenderRows: () => number;

  constructor(getScrollTop: () => number, getRenderRows: () => number) {
    this.getScrollTop = getScrollTop;
    this.getRenderRows = getRenderRows;
  }

  setSelection(item: TranscriptGutterSelection | undefined): void {
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

  invalidate(): void {}
}

export class FullscreenLayoutController {
  private readonly options: FullscreenLayoutControllerOptions;
  private installation: TranscriptLayoutInstallation | undefined;
  private restoreScrollIndicator: (() => void) | undefined;
  private scrollIndicatorRendererChildren: Component[] | undefined;

  constructor(options: FullscreenLayoutControllerOptions) {
    this.options = options;
  }

  activeScrollView(): PrivateScrollView | undefined {
    return (
      this.installation?.scrollView ??
      this.options.getTui()?.currentLayout?.primaryScrollView
    );
  }

  contentWidth(): number {
    const tui = this.options.getTui();
    if (!tui) return 1;
    const terminalWidth = Math.max(
      1,
      tui.terminal.columns - (this.installation ? TRANSCRIPT_GUTTER_WIDTH : 0),
    );
    return this.activeScrollView()?.getContentWidth?.(terminalWidth) ?? terminalWidth;
  }

  setSelection(item: TranscriptGutterSelection | undefined): void {
    this.installation?.gutter.setSelection(item);
  }

  ensure(): boolean {
    const tui = this.options.getTui();
    if (!tui) return false;

    const installation = this.installation;
    if (installation) {
      const sameRenderer = installation.rendererChildren === tui.children;
      const stillInstalled =
        tui.mode === "fullscreen" &&
        sameRenderer &&
        this.currentLayoutRoot() === installation.installedRoot;

      if (!stillInstalled) {
        installation.gutter.setSelection(undefined);
        this.installation = undefined;
        this.options.onIntegrationInvalidated?.();
        if (sameRenderer) this.restoreCurrentScrollIndicator();
        else this.abandonScrollIndicatorRestorer();
      }
    } else if (
      this.restoreScrollIndicator &&
      this.scrollIndicatorRendererChildren !== tui.children
    ) {
      this.abandonScrollIndicatorRestorer();
    }

    if (tui.mode !== "fullscreen") {
      this.restoreCurrentScrollIndicator();
      return false;
    }

    if (!this.installation && !this.install()) return false;

    if (!this.restoreScrollIndicator) {
      const restore = suppressDefaultScrollIndicator(
        tui,
        this.options.hideDefaultScrollIndicator,
      );
      if (restore) {
        this.restoreScrollIndicator = restore;
        this.scrollIndicatorRendererChildren = tui.children;
      }
    }

    return true;
  }

  restore(): void {
    const installation = this.installation;
    this.installation = undefined;

    const tui = this.options.getTui();
    if (
      installation &&
      tui?.setLayoutRoot &&
      installation.rendererChildren === tui.children
    ) {
      const currentRoot = this.currentLayoutRoot();
      if (!currentRoot || currentRoot === installation.installedRoot) {
        tui.setLayoutRoot(installation.originalRoot);
      }
    }

    this.restoreCurrentScrollIndicator();
  }

  private install(): boolean {
    const tui = this.options.getTui();
    if (!tui || tui.mode !== "fullscreen" || !tui.setLayoutRoot) return false;
    if (this.installation) return true;

    const originalRoot = this.currentLayoutRoot();
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
      () => this.options.getTui()?.terminal.rows ?? 1,
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
            this.options.getCursor,
            this.options.isSelecting,
          ),
          basis: 0,
          grow: 1,
          shrink: 1,
          minSize: 1,
        },
      ],
      { align: "stretch" },
    );
    const rootEntries = rootNode.entries.map((entry, index) =>
      index === transcriptIndex
        ? { ...entry, component: transcriptPane }
        : { ...entry },
    );
    const installedRoot = new VStack(rootEntries, {
      gap: rootNode.gap,
      align: rootNode.align,
    });

    this.installation = {
      originalRoot,
      installedRoot,
      scrollView,
      gutter,
      rendererChildren: tui.children,
    };
    tui.setLayoutRoot(installedRoot);
    return true;
  }

  private currentLayoutRoot(): Component | undefined {
    const tui = this.options.getTui();
    return tui?.currentLayout?.root?.component ?? tui?.layoutRoot;
  }

  private restoreCurrentScrollIndicator(): void {
    const tui = this.options.getTui();
    if (
      this.restoreScrollIndicator &&
      tui &&
      this.scrollIndicatorRendererChildren === tui.children
    ) {
      this.restoreScrollIndicator();
    }
    this.restoreScrollIndicator = undefined;
    this.scrollIndicatorRendererChildren = undefined;
  }

  private abandonScrollIndicatorRestorer(): void {
    this.restoreScrollIndicator = undefined;
    this.scrollIndicatorRendererChildren = undefined;
  }
}
