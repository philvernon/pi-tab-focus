import {
  stripTerminalSequences,
  type Component,
} from "@earendil-works/pi-tui";

export type TranscriptItemKind =
  | "prompt"
  | "message"
  | "tool"
  | "bash"
  | "skill"
  | "summary"
  | "custom";

export type TranscriptItem = {
  key: string;
  semanticKey: string;
  kind: TranscriptItemKind;
  startRow: number;
  endRow: number;
  gutterStartRow: number;
  gutterEndRow: number;
  text: string;
  linkSourceLines: string[];
};

export type TranscriptSnapshotChange = {
  contentChanged: boolean;
  geometryChanged: boolean;
  structureChanged: boolean;
  originChanged: boolean;
};

type ComponentWithChildren = Component & {
  children?: Component[];
  mouseLayout?: {
    width: number;
    children: Array<{ component: Component; height: number }>;
  };
};

type TranscriptMount = {
  root: Component;
  parent: ComponentWithChildren | undefined;
  transcript: ComponentWithChildren;
};

type ObservedEntry = {
  component: Component;
  kind: TranscriptItemKind | undefined;
  lines: string[];
  startRow: number;
};

type RelativeTranscriptItem = Omit<
  TranscriptItem,
  "startRow" | "endRow" | "gutterStartRow" | "gutterEndRow"
> & {
  startRow: number;
  endRow: number;
  gutterStartRow: number;
  gutterEndRow: number;
};

type TranscriptRenderObserverOptions = {
  getRoots: () => Component[];
  onSnapshotChange?: (change: TranscriptSnapshotChange) => void;
};

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

  while (textLines.length > 0 && textLines[0].trim().length === 0) {
    textLines.shift();
  }
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
    if (typeof toolCallId === "string" && toolCallId.length > 0) {
      return `tool:${toolCallId}`;
    }
  }

  return `${kind}:${hashText(text)}`;
}

function findTranscriptMountIn(
  component: Component,
  root: Component,
  parent: ComponentWithChildren | undefined,
): TranscriptMount | undefined {
  const children = componentChildren(component);
  if (children.some((child) => transcriptItemKind(child) !== undefined)) {
    return {
      root,
      parent,
      transcript: component as ComponentWithChildren,
    };
  }

  for (const child of children) {
    const found = findTranscriptMountIn(
      child,
      root,
      component as ComponentWithChildren,
    );
    if (found) return found;
  }

  return undefined;
}

function findMountedTranscript(roots: Component[]): TranscriptMount | undefined {
  for (const root of roots) {
    const found = findTranscriptMountIn(root, root, undefined);
    if (found) return found;
  }

  // Pi mounts documentContainer as the first TUI child with
  // [headerContainer, loadedResourcesContainer, chatContainer]. During
  // session_start the chat container is still empty, so semantic discovery
  // cannot identify it yet. This fallback lets observation start before Pi
  // renders resumed/history messages (including `pi -c`).
  const document = roots[0];
  if (!document) return undefined;

  const documentChildren = componentChildren(document);
  const transcript = documentChildren[2];
  if (!transcript) return undefined;

  return {
    root: document,
    parent: document as ComponentWithChildren,
    transcript: transcript as ComponentWithChildren,
  };
}

function linesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function relativeGeometryEqual(
  a: RelativeTranscriptItem[],
  b: RelativeTranscriptItem[],
): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const left = a[index];
    const right = b[index];
    if (
      left.key !== right.key ||
      left.kind !== right.kind ||
      left.startRow !== right.startRow ||
      left.endRow !== right.endRow ||
      left.gutterStartRow !== right.gutterStartRow ||
      left.gutterEndRow !== right.gutterEndRow
    ) {
      return false;
    }
  }
  return true;
}

function isBlankLine(line: string | undefined): boolean {
  return line !== undefined && stripTerminalSequences(line).trim().length === 0;
}

type MutableRenderable = Component & {
  render: (width: number) => string[];
};

function renderedChildLines(
  container: ComponentWithChildren,
  children: Component[],
  lines: string[],
): string[][] | undefined {
  const layout = container.mouseLayout?.children;
  if (!layout || layout.length !== children.length) return undefined;

  const rendered: string[][] = [];
  let row = 0;

  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    const measured = layout[index];
    if (!measured || measured.component !== child) return undefined;

    rendered.push(lines.slice(row, row + measured.height));
    row += measured.height;
  }

  return row === lines.length ? rendered : undefined;
}

export class TranscriptRenderObserver {
  private readonly options: TranscriptRenderObserverOptions;
  private mount: TranscriptMount | undefined;
  private restoreTranscriptRender: (() => void) | undefined;
  private restoreParentRender: (() => void) | undefined;
  private transcriptWrapper: ((width: number) => string[]) | undefined;
  private parentWrapper: ((width: number) => string[]) | undefined;
  private entries: ObservedEntry[] = [];
  private relativeItems: RelativeTranscriptItem[] = [];
  private absoluteItems: TranscriptItem[] = [];
  private transcriptHeight = 0;
  private transcriptStartRow = 0;
  private absoluteCacheStartRow: number | undefined;
  private snapshot = false;
  private parentRenderDepth = 0;
  private pendingChange: TranscriptSnapshotChange | undefined;
  private readonly componentKeys = new WeakMap<object, string>();
  private nextComponentKey = 1;

  constructor(options: TranscriptRenderObserverOptions) {
    this.options = options;
  }

  get hasSnapshot(): boolean {
    return this.snapshot;
  }

  get contentHeight(): number | undefined {
    if (!this.snapshot) return undefined;
    return this.transcriptStartRow + this.transcriptHeight;
  }

  ensureAttached(): boolean {
    const roots = this.options.getRoots();
    const nextMount = findMountedTranscript(roots);
    if (!nextMount) {
      this.detach();
      this.resetSnapshot();
      return false;
    }

    const sameMount =
      this.mount?.transcript === nextMount.transcript &&
      this.mount?.parent === nextMount.parent &&
      this.mount?.root === nextMount.root;

    const transcriptStillWrapped =
      sameMount &&
      this.transcriptWrapper !== undefined &&
      nextMount.transcript.render === this.transcriptWrapper;
    const parentStillWrapped =
      nextMount.parent === undefined ||
      (sameMount &&
        this.parentWrapper !== undefined &&
        nextMount.parent.render === this.parentWrapper);

    if (transcriptStillWrapped && parentStillWrapped) return true;

    this.detach();
    if (!sameMount) this.resetSnapshot();
    this.mount = nextMount;
    this.installTranscriptObserver(nextMount.transcript);
    if (nextMount.parent) this.installParentObserver(nextMount.parent);
    return true;
  }

  items(): TranscriptItem[] {
    this.ensureAttached();
    if (!this.snapshot) return [];

    if (
      this.absoluteCacheStartRow === this.transcriptStartRow &&
      this.absoluteItems.length === this.relativeItems.length
    ) {
      return this.absoluteItems;
    }

    this.absoluteItems = this.relativeItems.map((item) => ({
      ...item,
      startRow: this.transcriptStartRow + item.startRow,
      endRow: this.transcriptStartRow + item.endRow,
      gutterStartRow: this.transcriptStartRow + item.gutterStartRow,
      gutterEndRow: this.transcriptStartRow + item.gutterEndRow,
    }));
    this.absoluteCacheStartRow = this.transcriptStartRow;
    return this.absoluteItems;
  }

  dispose(): void {
    this.detach();
    this.resetSnapshot();
  }

  private installTranscriptObserver(transcript: ComponentWithChildren): void {
    const renderable = transcript as MutableRenderable;
    const hadOwnRender = Object.prototype.hasOwnProperty.call(
      renderable,
      "render",
    );
    const originalRender = renderable.render;
    const observer = this;

    const wrapper = function (this: Component, width: number): string[] {
      const children = componentChildren(transcript).slice();
      const lines = originalRender.call(this, width);
      const rendered = renderedChildLines(transcript, children, lines);

      if (rendered) observer.acceptTranscriptRender(children, rendered);
      if (observer.parentRenderDepth === 0) observer.flushChange();
      return lines;
    };

    renderable.render = wrapper;
    this.transcriptWrapper = wrapper;
    this.restoreTranscriptRender = () => {
      if (renderable.render !== wrapper) return;
      if (hadOwnRender) renderable.render = originalRender;
      else delete (renderable as Partial<MutableRenderable>).render;
    };
  }

  private installParentObserver(parent: ComponentWithChildren): void {
    const renderable = parent as MutableRenderable;
    const hadOwnRender = Object.prototype.hasOwnProperty.call(
      renderable,
      "render",
    );
    const originalRender = renderable.render;
    const observer = this;

    const wrapper = function (this: Component, width: number): string[] {
      observer.parentRenderDepth++;
      const transcript = observer.mount?.transcript;
      const children = componentChildren(parent).slice();

      let lines: string[];
      try {
        lines = originalRender.call(this, width);
      } finally {
        const transcriptIndex = transcript ? children.indexOf(transcript) : -1;
        const layout = parent.mouseLayout?.children;

        if (
          transcriptIndex >= 0 &&
          layout &&
          layout.length === children.length &&
          layout.every(
            (entry, index) => entry.component === children[index],
          )
        ) {
          const startRow = layout
            .slice(0, transcriptIndex)
            .reduce((sum, entry) => sum + entry.height, 0);

          if (startRow !== observer.transcriptStartRow) {
            observer.transcriptStartRow = startRow;
            observer.absoluteCacheStartRow = undefined;
            observer.mergePendingChange({
              contentChanged: false,
              geometryChanged: true,
              structureChanged: false,
              originChanged: true,
            });
          }
        }

        observer.parentRenderDepth--;
        if (observer.parentRenderDepth === 0) observer.flushChange();
      }

      return lines;
    };

    renderable.render = wrapper;
    this.parentWrapper = wrapper;
    this.restoreParentRender = () => {
      if (renderable.render !== wrapper) return;
      if (hadOwnRender) renderable.render = originalRender;
      else delete (renderable as Partial<MutableRenderable>).render;
    };
  }

  private acceptTranscriptRender(
    children: Component[],
    rendered: string[][],
  ): void {
    const previousEntries = this.entries;
    const previousItems = this.relativeItems;
    const nextEntries: ObservedEntry[] = [];
    let row = 0;

    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      const lines = rendered[index] ?? [];
      nextEntries.push({
        component: child,
        kind: transcriptItemKind(child),
        lines,
        startRow: row,
      });
      row += lines.length;
    }

    const structureChanged =
      previousEntries.length !== nextEntries.length ||
      previousEntries.some(
        (entry, index) => entry.component !== nextEntries[index]?.component,
      );
    const contentChanged =
      structureChanged ||
      previousEntries.some((entry, index) => {
        const next = nextEntries[index];
        return !next || !linesEqual(entry.lines, next.lines);
      });

    this.entries = nextEntries;
    this.transcriptHeight = row;
    this.snapshot = true;

    if (!contentChanged) return;

    const nextItems = this.buildRelativeItems(nextEntries, row);
    const geometryChanged = !relativeGeometryEqual(previousItems, nextItems);
    this.relativeItems = nextItems;
    this.absoluteCacheStartRow = undefined;

    this.mergePendingChange({
      contentChanged: true,
      geometryChanged,
      structureChanged,
      originChanged: false,
    });
  }

  private buildRelativeItems(
    entries: ObservedEntry[],
    transcriptHeight: number,
  ): RelativeTranscriptItem[] {
    const duplicateKeys = new Map<string, number>();
    const items: RelativeTranscriptItem[] = [];

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const kind = entry.kind;
      const bounds = kind ? visibleLineBounds(entry.lines) : undefined;
      if (!kind || !bounds) continue;

      const text = trimRenderedText(entry.lines);
      const baseKey = semanticItemBaseKey(entry.component, kind, text);
      const occurrence = duplicateKeys.get(baseKey) ?? 0;
      duplicateKeys.set(baseKey, occurrence + 1);

      const startRow = entry.startRow + bounds.first;
      const endRow = entry.startRow + bounds.last + 1;
      const previousLine =
        bounds.first > 0
          ? entry.lines[bounds.first - 1]
          : entries[index - 1]?.lines.at(-1);
      const nextLine =
        bounds.last + 1 < entry.lines.length
          ? entry.lines[bounds.last + 1]
          : entries[index + 1]?.lines[0];

      items.push({
        key: this.componentKey(entry.component, kind),
        semanticKey: `${baseKey}:${occurrence}`,
        kind,
        startRow,
        endRow,
        gutterStartRow:
          startRow > 0 && isBlankLine(previousLine) ? startRow - 1 : startRow,
        gutterEndRow:
          endRow < transcriptHeight && isBlankLine(nextLine)
            ? endRow + 1
            : endRow,
        text,
        linkSourceLines: entry.lines,
      });
    }

    return items;
  }

  private componentKey(
    component: Component,
    kind: TranscriptItemKind,
  ): string {
    if (kind === "tool") {
      const toolCallId = (component as { toolCallId?: unknown }).toolCallId;
      if (typeof toolCallId === "string" && toolCallId.length > 0) {
        return `tool:${toolCallId}`;
      }
    }

    const object = component as object;
    let key = this.componentKeys.get(object);
    if (!key) {
      key = `${kind}:component:${this.nextComponentKey++}`;
      this.componentKeys.set(object, key);
    }
    return key;
  }

  private mergePendingChange(change: TranscriptSnapshotChange): void {
    const previous = this.pendingChange;
    this.pendingChange = previous
      ? {
        contentChanged: previous.contentChanged || change.contentChanged,
        geometryChanged: previous.geometryChanged || change.geometryChanged,
        structureChanged: previous.structureChanged || change.structureChanged,
        originChanged: previous.originChanged || change.originChanged,
      }
      : change;
  }

  private flushChange(): void {
    const change = this.pendingChange;
    if (!change) return;
    this.pendingChange = undefined;
    this.options.onSnapshotChange?.(change);
  }

  private resetSnapshot(): void {
    this.entries = [];
    this.relativeItems = [];
    this.absoluteItems = [];
    this.transcriptHeight = 0;
    this.transcriptStartRow = 0;
    this.absoluteCacheStartRow = undefined;
    this.snapshot = false;
    this.pendingChange = undefined;
  }

  private detach(): void {
    this.restoreParentRender?.();
    this.restoreTranscriptRender?.();
    this.restoreParentRender = undefined;
    this.restoreTranscriptRender = undefined;
    this.parentWrapper = undefined;
    this.transcriptWrapper = undefined;
    this.mount = undefined;
    this.parentRenderDepth = 0;
  }
}
