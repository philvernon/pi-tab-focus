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

type ComponentWithChildren = Component & {
  children?: Component[];
};

type TranscriptEntry = {
  component: Component;
  kind: TranscriptItemKind | undefined;
  lines: string[];
  startRow: number;
  visibleFirst: number | undefined;
  visibleLast: number | undefined;
  semanticBaseKey: string | undefined;
  item: TranscriptItem | undefined;
  dirty: boolean;
};

type TranscriptContainer = {
  component: ComponentWithChildren;
  startRow: number;
};

type TranscriptIndexOptions = {
  getRoots: () => Component[];
  getWidth: () => number;
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

function findTranscriptContainer(
  component: Component,
  width: number,
  startRow = 0,
): TranscriptContainer | undefined {
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
): TranscriptContainer | undefined {
  for (const root of roots) {
    const found = findTranscriptContainer(root, width, 0);
    if (found) return found;
  }

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

function isBlankLine(line: string | undefined): boolean {
  return line !== undefined && stripTerminalSequences(line).trim().length === 0;
}

export class TranscriptIndex {
  private readonly options: TranscriptIndexOptions;
  private width: number | undefined;
  private transcript: TranscriptContainer | undefined;
  private entries: TranscriptEntry[] = [];
  private itemsCache: TranscriptItem[] = [];
  private readonly componentKeys = new WeakMap<object, string>();
  private nextComponentKey = 1;
  private readonly toolEntries = new Map<string, TranscriptEntry>();
  private latestAssistantEntry: TranscriptEntry | undefined;
  private pendingAssistantDirty = false;
  private pendingToolDirty = new Set<string>();
  private readonly dirtyEntries = new Set<TranscriptEntry>();
  private structureDirty = true;
  private allDirty = true;
  private initialized = false;
  private contentHeightValue: number | undefined;

  constructor(options: TranscriptIndexOptions) {
    this.options = options;
  }

  get contentHeight(): number | undefined {
    return this.contentHeightValue;
  }

  get needsRefresh(): boolean {
    return (
      !this.initialized ||
      this.allDirty ||
      this.structureDirty ||
      this.pendingAssistantDirty ||
      this.pendingToolDirty.size > 0 ||
      this.dirtyEntries.size > 0
    );
  }

  reset(): void {
    this.width = undefined;
    this.transcript = undefined;
    this.entries = [];
    this.itemsCache = [];
    this.toolEntries.clear();
    this.latestAssistantEntry = undefined;
    this.pendingAssistantDirty = false;
    this.pendingToolDirty.clear();
    this.dirtyEntries.clear();
    this.structureDirty = true;
    this.allDirty = true;
    this.initialized = false;
    this.contentHeightValue = undefined;
  }

  invalidateAll(): void {
    this.allDirty = true;
    this.structureDirty = true;
  }

  invalidateStructure(): void {
    this.structureDirty = true;
  }

  invalidateAssistant(): void {
    if (this.structureDirty || !this.latestAssistantEntry) {
      this.pendingAssistantDirty = true;
      this.structureDirty = true;
      return;
    }

    this.markEntryDirty(this.latestAssistantEntry);
  }

  invalidateTool(toolCallId: string): void {
    const entry = this.toolEntries.get(toolCallId);
    if (entry) {
      this.markEntryDirty(entry);
      return;
    }

    this.pendingToolDirty.add(toolCallId);
    this.structureDirty = true;
  }

  hasTool(toolCallId: string): boolean {
    return this.toolEntries.has(toolCallId);
  }

  items(): TranscriptItem[] {
    if (!this.initialized) return this.refresh();
    return this.itemsCache;
  }

  refresh(): TranscriptItem[] {
    const width = this.options.getWidth();
    if (!this.initialized || this.allDirty || this.width !== width) {
      return this.rebuildAll(width);
    }
    if (!this.needsRefresh) return this.itemsCache;

    let firstChanged = Number.POSITIVE_INFINITY;

    if (this.structureDirty) {
      firstChanged = Math.min(firstChanged, this.syncStructure(width));
      this.structureDirty = false;
    }

    this.resolvePendingInvalidations(firstChanged);

    for (const entry of [...this.dirtyEntries]) {
      const index = this.entries.indexOf(entry);
      if (index < 0) {
        this.dirtyEntries.delete(entry);
        continue;
      }
      this.renderEntry(entry, width);
      firstChanged = Math.min(firstChanged, index);
    }

    if (Number.isFinite(firstChanged)) {
      this.rebuildDerivedState();
    }

    return this.itemsCache;
  }

  private rebuildAll(width: number): TranscriptItem[] {
    this.width = width;
    this.transcript = findMountedTranscriptContainer(
      this.options.getRoots(),
      width,
    );
    this.entries = [];
    this.itemsCache = [];
    this.toolEntries.clear();
    this.dirtyEntries.clear();
    this.latestAssistantEntry = undefined;

    if (!this.transcript) {
      this.pendingAssistantDirty = false;
      this.pendingToolDirty.clear();
      this.structureDirty = false;
      this.allDirty = false;
      this.initialized = true;
      this.contentHeightValue = undefined;
      return this.itemsCache;
    }

    for (const component of this.transcript.component.children ?? []) {
      const entry = this.createEntry(component);
      this.renderEntry(entry, width);
      this.entries.push(entry);
    }

    this.rebuildDerivedState();
    this.pendingAssistantDirty = false;
    this.pendingToolDirty.clear();
    this.structureDirty = false;
    this.allDirty = false;
    this.initialized = true;
    return this.itemsCache;
  }

  private syncStructure(width: number): number {
    const transcript = this.transcript;
    if (!transcript) {
      this.allDirty = true;
      this.rebuildAll(width);
      return 0;
    }

    const children = transcript.component.children ?? [];
    const sharedLength = Math.min(children.length, this.entries.length);
    let firstChanged = sharedLength;

    for (let index = 0; index < sharedLength; index++) {
      if (this.entries[index]?.component !== children[index]) {
        firstChanged = index;
        break;
      }
    }

    if (
      firstChanged === sharedLength &&
      children.length === this.entries.length
    ) {
      return Number.POSITIVE_INFINITY;
    }

    this.entries.length = firstChanged;
    for (const dirty of [...this.dirtyEntries]) {
      if (!this.entries.includes(dirty)) this.dirtyEntries.delete(dirty);
    }
    for (let index = firstChanged; index < children.length; index++) {
      const entry = this.createEntry(children[index]);
      this.renderEntry(entry, width);
      this.entries.push(entry);
    }

    return firstChanged;
  }

  private createEntry(component: Component): TranscriptEntry {
    return {
      component,
      kind: transcriptItemKind(component),
      lines: [],
      startRow: 0,
      visibleFirst: undefined,
      visibleLast: undefined,
      semanticBaseKey: undefined,
      item: undefined,
      dirty: true,
    };
  }

  private renderEntry(entry: TranscriptEntry, width: number): void {
    entry.lines = entry.component.render(width);
    entry.dirty = false;
    this.dirtyEntries.delete(entry);

    if (!entry.kind) {
      entry.visibleFirst = undefined;
      entry.visibleLast = undefined;
      entry.semanticBaseKey = undefined;
      entry.item = undefined;
      return;
    }

    const bounds = visibleLineBounds(entry.lines);
    if (!bounds) {
      entry.visibleFirst = undefined;
      entry.visibleLast = undefined;
      entry.semanticBaseKey = undefined;
      entry.item = undefined;
      return;
    }

    const text = trimRenderedText(entry.lines);
    entry.visibleFirst = bounds.first;
    entry.visibleLast = bounds.last;
    entry.semanticBaseKey = semanticItemBaseKey(
      entry.component,
      entry.kind,
      text,
    );

    if (!entry.item) {
      entry.item = {
        key: this.componentKey(entry.component, entry.kind),
        semanticKey: "",
        kind: entry.kind,
        startRow: 0,
        endRow: 0,
        gutterStartRow: 0,
        gutterEndRow: 0,
        text,
        linkSourceLines: entry.lines,
      };
    } else {
      entry.item.kind = entry.kind;
      entry.item.text = text;
      entry.item.linkSourceLines = entry.lines;
    }
  }

  private rebuildDerivedState(): void {
    const transcriptStartRow = this.transcript?.startRow ?? 0;
    let row = transcriptStartRow;

    this.toolEntries.clear();
    this.latestAssistantEntry = undefined;

    for (const entry of this.entries) {
      entry.startRow = row;
      row += entry.lines.length;

      if (componentName(entry.component) === "AssistantMessageComponent") {
        this.latestAssistantEntry = entry;
      }

      if (entry.kind === "tool") {
        const toolCallId = (entry.component as { toolCallId?: unknown })
          .toolCallId;
        if (typeof toolCallId === "string" && toolCallId.length > 0) {
          this.toolEntries.set(toolCallId, entry);
        }
      }
    }

    this.contentHeightValue = row;

    const duplicateKeys = new Map<string, number>();
    const items: TranscriptItem[] = [];

    for (let index = 0; index < this.entries.length; index++) {
      const entry = this.entries[index];
      const item = entry.item;
      const first = entry.visibleFirst;
      const last = entry.visibleLast;
      const baseKey = entry.semanticBaseKey;
      if (!item || first === undefined || last === undefined || !baseKey) {
        continue;
      }

      const occurrence = duplicateKeys.get(baseKey) ?? 0;
      duplicateKeys.set(baseKey, occurrence + 1);
      item.semanticKey = `${baseKey}:${occurrence}`;

      const visibleStartRow = entry.startRow + first;
      const visibleEndRow = entry.startRow + last + 1;
      const previousLine =
        first > 0
          ? entry.lines[first - 1]
          : this.entries[index - 1]?.lines.at(-1);
      const nextLine =
        last + 1 < entry.lines.length
          ? entry.lines[last + 1]
          : this.entries[index + 1]?.lines[0];

      item.startRow = visibleStartRow;
      item.endRow = visibleEndRow;
      item.gutterStartRow =
        visibleStartRow > transcriptStartRow && isBlankLine(previousLine)
          ? visibleStartRow - 1
          : visibleStartRow;
      item.gutterEndRow =
        visibleEndRow < row && isBlankLine(nextLine)
          ? visibleEndRow + 1
          : visibleEndRow;

      items.push(item);
    }

    this.itemsCache = items;
  }

  private resolvePendingInvalidations(firstChanged: number): void {
    if (this.pendingAssistantDirty) {
      const entry = this.entries
        .toReversed()
        .find(
          (candidate) =>
            componentName(candidate.component) === "AssistantMessageComponent",
        );
      if (entry) {
        const index = this.entries.indexOf(entry);
        if (index < firstChanged) this.markEntryDirty(entry);
        this.pendingAssistantDirty = false;
      }
    }

    if (this.pendingToolDirty.size > 0) {
      for (const toolCallId of [...this.pendingToolDirty]) {
        const entry =
          this.toolEntries.get(toolCallId) ??
          this.entries.find((candidate) => {
            if (candidate.kind !== "tool") return false;
            return (
              (candidate.component as { toolCallId?: unknown }).toolCallId ===
              toolCallId
            );
          });
        if (!entry) continue;
        const index = this.entries.indexOf(entry);
        if (index < firstChanged) this.markEntryDirty(entry);
        this.pendingToolDirty.delete(toolCallId);
      }
    }
  }

  private markEntryDirty(entry: TranscriptEntry): void {
    entry.dirty = true;
    this.dirtyEntries.add(entry);
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
}
