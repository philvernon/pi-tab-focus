export type VimPoint = {
  row: number;
  col: number;
};

export type VimCell = {
  start: number;
  end: number;
  text: string;
};

export type VimTextSource = {
  lineCount: number;
  revision?: number;
  line: (row: number) => readonly VimCell[];
};

export type VimSelectionKind = "character" | "line";

export type VimVisualSnapshot = {
  head: VimPoint;
  anchor?: VimPoint;
  selectionKind?: VimSelectionKind;
  preferredCol: number;
  pending: string;
  count?: number;
};

export type VimVisualCommand = "copy" | "open-link" | "ex" | "exit";

export type VimHandleResult = {
  handled: boolean;
  command?: VimVisualCommand;
};

type FindState = {
  char: string;
  direction: -1 | 1;
  till: boolean;
};

type PendingState =
  | { kind: "g" }
  | { kind: "find"; direction: -1 | 1; till: boolean }
  | { kind: "text-object"; around: boolean };

type FlatToken =
  | {
      kind: "cell";
      point: VimPoint;
      text: string;
      wordClass: "word" | "punct" | "space";
      bigWordClass: "word" | "space";
    }
  | {
      kind: "newline";
      wordClass: "space";
      bigWordClass: "space";
    };

type PointRange = {
  start: VimPoint;
  end: VimPoint;
};

const WORD_CHAR = /^[\p{L}\p{M}\p{N}_]+$/u;
const WHITESPACE = /^\s+$/u;
const FLAT_TOKEN_CACHE = new WeakMap<
  VimTextSource,
  { revision: number; tokens: FlatToken[] }
>();

export function compareVimPoints(left: VimPoint, right: VimPoint): number {
  return left.row === right.row ? left.col - right.col : left.row - right.row;
}

export function firstNonWhitespaceColumn(
  source: VimTextSource,
  row: number,
): number {
  for (const cell of source.line(clampRow(source, row))) {
    if (!isWhitespace(cell.text)) return cell.start;
  }
  return 0;
}

function isWhitespace(text: string): boolean {
  return WHITESPACE.test(text);
}

function classifySmall(text: string): "word" | "punct" | "space" {
  if (isWhitespace(text)) return "space";
  return WORD_CHAR.test(text) ? "word" : "punct";
}

function classifyBig(text: string): "word" | "space" {
  return isWhitespace(text) ? "space" : "word";
}

function clampRow(source: VimTextSource, row: number): number {
  if (source.lineCount <= 0) return 0;
  return Math.max(0, Math.min(source.lineCount - 1, row));
}

function clonePoint(point: VimPoint): VimPoint {
  return { row: point.row, col: point.col };
}

function lineCells(source: VimTextSource, row: number): readonly VimCell[] {
  if (source.lineCount <= 0) return [];
  return source.line(clampRow(source, row));
}

function nearestColumn(
  source: VimTextSource,
  row: number,
  preferred: number,
): number {
  const cells = lineCells(source, row);
  if (cells.length === 0) return 0;
  const containing = cells.find(
    (cell) => preferred >= cell.start && preferred < cell.end,
  );
  if (containing) return containing.start;
  const last = cells[cells.length - 1];
  if (last && preferred >= last.end) return last.start;
  return cells.find((cell) => cell.start >= preferred)?.start ?? 0;
}

function cellIndexAt(cells: readonly VimCell[], col: number): number {
  const exact = cells.findIndex((cell) => cell.start === col);
  if (exact >= 0) return exact;
  const containing = cells.findIndex(
    (cell) => col >= cell.start && col < cell.end,
  );
  if (containing >= 0) return containing;
  const before = cells.findLastIndex((cell) => cell.start < col);
  return before >= 0 ? before : 0;
}

function flatten(source: VimTextSource): FlatToken[] {
  if (source.revision !== undefined) {
    const cached = FLAT_TOKEN_CACHE.get(source);
    if (cached?.revision === source.revision) return cached.tokens;
  }

  const tokens: FlatToken[] = [];
  for (let row = 0; row < source.lineCount; row++) {
    for (const cell of source.line(row)) {
      tokens.push({
        kind: "cell",
        point: { row, col: cell.start },
        text: cell.text,
        wordClass: classifySmall(cell.text),
        bigWordClass: classifyBig(cell.text),
      });
    }
    if (row < source.lineCount - 1) {
      tokens.push({
        kind: "newline",
        wordClass: "space",
        bigWordClass: "space",
      });
    }
  }
  if (source.revision !== undefined) {
    FLAT_TOKEN_CACHE.set(source, { revision: source.revision, tokens });
  }
  return tokens;
}

function tokenPoint(token: FlatToken | undefined): VimPoint | undefined {
  return token?.kind === "cell" ? token.point : undefined;
}

function tokenIndexAtOrAfter(tokens: FlatToken[], point: VimPoint): number {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== "cell") continue;
    if (
      token.point.row > point.row ||
      (token.point.row === point.row && token.point.col >= point.col)
    ) {
      return index;
    }
  }
  return Math.max(0, tokens.length - 1);
}

function tokenIndexAtOrBefore(tokens: FlatToken[], point: VimPoint): number {
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];
    if (token.kind !== "cell") continue;
    if (
      token.point.row < point.row ||
      (token.point.row === point.row && token.point.col <= point.col)
    ) {
      return index;
    }
  }
  return 0;
}

function nonSpaceTokenPoint(
  tokens: FlatToken[],
  index: number,
  direction: -1 | 1,
): VimPoint | undefined {
  for (
    let cursor = index;
    cursor >= 0 && cursor < tokens.length;
    cursor += direction
  ) {
    const token = tokens[cursor];
    if (token.kind === "cell" && token.wordClass !== "space") {
      return token.point;
    }
  }
  return undefined;
}

function wordClass(token: FlatToken, big: boolean): string {
  return big ? token.bigWordClass : token.wordClass;
}

function wordForwardOnce(
  source: VimTextSource,
  point: VimPoint,
  big: boolean,
): VimPoint {
  const tokens = flatten(source);
  if (tokens.length === 0) return point;
  let index = tokenIndexAtOrAfter(tokens, point);
  const token = tokens[index];
  const isCurrentCell =
    token.kind === "cell" &&
    token.point.row === point.row &&
    token.point.col === point.col;

  if (isCurrentCell && wordClass(token, big) !== "space") {
    const currentClass = wordClass(token, big);
    index++;
    while (
      index < tokens.length &&
      wordClass(tokens[index], big) === currentClass
    ) {
      index++;
    }
  }

  while (index < tokens.length && wordClass(tokens[index], big) === "space") {
    index++;
  }

  return tokenPoint(tokens[index]) ?? point;
}

function wordBackwardOnce(
  source: VimTextSource,
  point: VimPoint,
  big: boolean,
): VimPoint {
  const tokens = flatten(source);
  if (tokens.length === 0) return point;
  let index = tokenIndexAtOrBefore(tokens, point);
  const current = tokens[index];

  if (
    current.kind === "cell" &&
    current.point.row === point.row &&
    current.point.col === point.col &&
    wordClass(current, big) !== "space"
  ) {
    index--;
  }

  while (index >= 0 && wordClass(tokens[index], big) === "space") index--;
  if (index < 0) return point;

  const targetClass = wordClass(tokens[index], big);
  while (
    index > 0 &&
    wordClass(tokens[index - 1], big) === targetClass
  ) {
    index--;
  }

  return tokenPoint(tokens[index]) ??
    nonSpaceTokenPoint(tokens, index, 1) ??
    point;
}

function wordEndOnce(
  source: VimTextSource,
  point: VimPoint,
  big: boolean,
): VimPoint {
  const tokens = flatten(source);
  if (tokens.length === 0) return point;
  let index = tokenIndexAtOrAfter(tokens, point);
  const token = tokens[index];
  const isCurrentCell =
    token.kind === "cell" &&
    token.point.row === point.row &&
    token.point.col === point.col;

  if (wordClass(token, big) === "space") {
    while (index < tokens.length && wordClass(tokens[index], big) === "space") {
      index++;
    }
  } else if (isCurrentCell) {
    const currentClass = wordClass(token, big);
    let cursor = index;
    while (
      cursor + 1 < tokens.length &&
      wordClass(tokens[cursor + 1], big) === currentClass
    ) {
      cursor++;
    }
    if (cursor > index) return tokenPoint(tokens[cursor]) ?? point;
    index = cursor + 1;
    while (index < tokens.length && wordClass(tokens[index], big) === "space") {
      index++;
    }
  }

  if (index >= tokens.length) return point;
  const targetClass = wordClass(tokens[index], big);
  while (
    index + 1 < tokens.length &&
    wordClass(tokens[index + 1], big) === targetClass
  ) {
    index++;
  }
  return tokenPoint(tokens[index]) ?? point;
}

function wordEndBackwardOnce(
  source: VimTextSource,
  point: VimPoint,
  big: boolean,
): VimPoint {
  const tokens = flatten(source);
  if (tokens.length === 0) return point;
  let index = tokenIndexAtOrBefore(tokens, point);
  const current = tokens[index];

  if (
    current?.kind === "cell" &&
    current.point.row === point.row &&
    current.point.col === point.col &&
    wordClass(current, big) !== "space"
  ) {
    const currentClass = wordClass(current, big);
    while (index >= 0 && wordClass(tokens[index], big) === currentClass) index--;
  }

  while (index >= 0 && wordClass(tokens[index], big) === "space") index--;
  return tokenPoint(tokens[index]) ?? point;
}

function repeatMotion(
  point: VimPoint,
  count: number,
  motion: (current: VimPoint) => VimPoint,
): VimPoint {
  let result = point;
  for (let index = 0; index < count; index++) result = motion(result);
  return result;
}

function lineStart(source: VimTextSource, row: number): VimPoint {
  return { row: clampRow(source, row), col: 0 };
}

function lineEnd(source: VimTextSource, row: number): VimPoint {
  const clamped = clampRow(source, row);
  const cells = source.line(clamped);
  return { row: clamped, col: cells[cells.length - 1]?.start ?? 0 };
}

function paragraphMotion(
  source: VimTextSource,
  point: VimPoint,
  direction: -1 | 1,
  count: number,
): VimPoint {
  let row = point.row;
  const isBlank = (candidate: number) =>
    source.line(candidate).every((cell) => isWhitespace(cell.text));

  for (let iteration = 0; iteration < count; iteration++) {
    row += direction;
    while (row >= 0 && row < source.lineCount && !isBlank(row)) row += direction;
    while (row >= 0 && row < source.lineCount && isBlank(row)) row += direction;
    if (row < 0) {
      row = 0;
      break;
    }
    if (row >= source.lineCount) {
      row = Math.max(0, source.lineCount - 1);
      break;
    }
  }

  return {
    row,
    col: firstNonWhitespaceColumn(source, row),
  };
}

function findOnLine(
  source: VimTextSource,
  point: VimPoint,
  state: FindState,
  count: number,
): VimPoint {
  const cells = source.line(clampRow(source, point.row));
  if (cells.length === 0) return point;
  const current = cellIndexAt(cells, point.col);
  let found = -1;
  let remaining = count;

  if (state.direction > 0) {
    for (let index = current + 1; index < cells.length; index++) {
      if (cells[index]?.text !== state.char) continue;
      remaining--;
      if (remaining === 0) {
        found = index;
        break;
      }
    }
  } else {
    for (let index = current - 1; index >= 0; index--) {
      if (cells[index]?.text !== state.char) continue;
      remaining--;
      if (remaining === 0) {
        found = index;
        break;
      }
    }
  }

  if (found < 0) return point;
  let target = found;
  if (state.till) target -= state.direction;
  target = Math.max(0, Math.min(cells.length - 1, target));
  return { row: point.row, col: cells[target]?.start ?? point.col };
}

function matchingBracket(
  source: VimTextSource,
  point: VimPoint,
): VimPoint | undefined {
  const tokens = flatten(source);
  const pairs: Record<string, [string, string, -1 | 1]> = {
    "(": ["(", ")", 1],
    ")": ["(", ")", -1],
    "[": ["[", "]", 1],
    "]": ["[", "]", -1],
    "{": ["{", "}", 1],
    "}": ["{", "}", -1],
  };

  let origin = -1;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== "cell" || token.point.row !== point.row) continue;
    if (token.point.col < point.col) continue;
    if (pairs[token.text]) {
      origin = index;
      break;
    }
  }
  if (origin < 0) return undefined;

  const originToken = tokens[origin];
  if (originToken.kind !== "cell") return undefined;
  const [open, close, direction] = pairs[originToken.text];
  let depth = 0;
  for (
    let index = origin;
    index >= 0 && index < tokens.length;
    index += direction
  ) {
    const token = tokens[index];
    if (token.kind !== "cell") continue;
    if (direction > 0) {
      if (token.text === open) depth++;
      else if (token.text === close) depth--;
    } else {
      if (token.text === close) depth++;
      else if (token.text === open) depth--;
    }
    if (depth === 0 && index !== origin) return token.point;
  }
  return undefined;
}

function wordRange(
  source: VimTextSource,
  point: VimPoint,
  big: boolean,
  around: boolean,
): PointRange | undefined {
  const tokens = flatten(source);
  if (tokens.length === 0) return undefined;
  let index = tokenIndexAtOrAfter(tokens, point);

  if (wordClass(tokens[index], big) === "space") {
    while (index < tokens.length && wordClass(tokens[index], big) === "space") {
      index++;
    }
  }
  if (index >= tokens.length) return undefined;

  const targetClass = wordClass(tokens[index], big);
  let start = index;
  let end = index;
  while (start > 0 && wordClass(tokens[start - 1], big) === targetClass) start--;
  while (
    end + 1 < tokens.length &&
    wordClass(tokens[end + 1], big) === targetClass
  ) {
    end++;
  }

  if (around) {
    let trailing = end + 1;
    while (
      trailing < tokens.length &&
      tokens[trailing].kind === "cell" &&
      wordClass(tokens[trailing], big) === "space"
    ) {
      end = trailing;
      trailing++;
    }
    if (end === index || wordClass(tokens[end], big) !== "space") {
      let leading = start - 1;
      while (
        leading >= 0 &&
        tokens[leading].kind === "cell" &&
        wordClass(tokens[leading], big) === "space"
      ) {
        start = leading;
        leading--;
      }
    }
  }

  const startPoint = tokenPoint(tokens[start]);
  const endPoint = tokenPoint(tokens[end]);
  if (!startPoint || !endPoint) return undefined;
  return { start: startPoint, end: endPoint };
}

function quoteRange(
  source: VimTextSource,
  point: VimPoint,
  quote: string,
  around: boolean,
): PointRange | undefined {
  const cells = source.line(clampRow(source, point.row));
  if (cells.length === 0) return undefined;
  const cursorIndex = cellIndexAt(cells, point.col);
  const quoteIndices: number[] = [];
  for (let index = 0; index < cells.length; index++) {
    if (cells[index]?.text === quote && cells[index - 1]?.text !== "\\") {
      quoteIndices.push(index);
    }
  }

  let pair: [number, number] | undefined;
  for (let index = 0; index + 1 < quoteIndices.length; index += 2) {
    const open = quoteIndices[index];
    const close = quoteIndices[index + 1];
    if (cursorIndex >= open && cursorIndex <= close) {
      pair = [open, close];
      break;
    }
  }
  if (!pair) return undefined;

  const [open, close] = pair;
  const startIndex = around ? open : open + 1;
  const endIndex = around ? close : close - 1;
  if (startIndex > endIndex) return undefined;
  const start = cells[startIndex];
  const end = cells[endIndex];
  if (!start || !end) return undefined;
  return {
    start: { row: point.row, col: start.start },
    end: { row: point.row, col: end.start },
  };
}

function bracketRange(
  source: VimTextSource,
  point: VimPoint,
  openChar: string,
  closeChar: string,
  around: boolean,
): PointRange | undefined {
  const tokens = flatten(source);
  if (tokens.length === 0) return undefined;
  const cursor = tokenIndexAtOrAfter(tokens, point);

  for (let open = cursor; open >= 0; open--) {
    const token = tokens[open];
    if (token.kind !== "cell" || token.text !== openChar) continue;
    let depth = 0;
    for (let close = open; close < tokens.length; close++) {
      const candidate = tokens[close];
      if (candidate.kind !== "cell") continue;
      if (candidate.text === openChar) depth++;
      else if (candidate.text === closeChar) depth--;
      if (depth !== 0) continue;
      if (close < cursor) break;
      const startIndex = around ? open : open + 1;
      const endIndex = around ? close : close - 1;
      const start = nonSpaceOrCellPoint(tokens, startIndex, 1, endIndex);
      const end = nonSpaceOrCellPoint(tokens, endIndex, -1, startIndex);
      if (!start || !end || compareVimPoints(start, end) > 0) return undefined;
      return { start, end };
    }
  }
  return undefined;
}

function nonSpaceOrCellPoint(
  tokens: FlatToken[],
  index: number,
  direction: -1 | 1,
  limit: number,
): VimPoint | undefined {
  for (
    let cursor = index;
    direction > 0 ? cursor <= limit : cursor >= limit;
    cursor += direction
  ) {
    const point = tokenPoint(tokens[cursor]);
    if (point) return point;
  }
  return undefined;
}

function textObjectRange(
  source: VimTextSource,
  point: VimPoint,
  object: string,
  around: boolean,
  count: number,
): PointRange | undefined {
  if (object === "w" || object === "W") {
    let range = wordRange(source, point, object === "W", around);
    if (!range) return undefined;
    for (let iteration = 1; iteration < count; iteration++) {
      const next = wordRange(
        source,
        wordForwardOnce(source, range.end, object === "W"),
        object === "W",
        around,
      );
      if (!next) break;
      range = { start: range.start, end: next.end };
    }
    return range;
  }

  if (object === '"' || object === "'" || object === "`") {
    return quoteRange(source, point, object, around);
  }

  const bracketPairs: Record<string, [string, string]> = {
    "(": ["(", ")"],
    ")": ["(", ")"],
    b: ["(", ")"],
    "[": ["[", "]"],
    "]": ["[", "]"],
    "{": ["{", "}"],
    "}": ["{", "}"],
    B: ["{", "}"],
    "<": ["<", ">"],
    ">": ["<", ">"],
  };
  const pair = bracketPairs[object];
  return pair
    ? bracketRange(source, point, pair[0], pair[1], around)
    : undefined;
}

export class VimVisualNavigation {
  private head: VimPoint;
  private anchor: VimPoint | undefined;
  private selectionKind: VimSelectionKind | undefined;
  private preferredCol: number;
  private countBuffer = "";
  private pending: PendingState | undefined;
  private lastFind: FindState | undefined;

  constructor(start: VimPoint) {
    this.head = clonePoint(start);
    this.preferredCol = start.col;
  }

  snapshot(): VimVisualSnapshot {
    return {
      head: clonePoint(this.head),
      anchor: this.anchor ? clonePoint(this.anchor) : undefined,
      selectionKind: this.selectionKind,
      preferredCol: this.preferredCol,
      pending: this.pendingLabel(),
      count: this.countBuffer ? Number(this.countBuffer) : undefined,
    };
  }

  isSelecting(): boolean {
    return Boolean(this.selectionKind);
  }

  clamp(source: VimTextSource): void {
    this.head.row = clampRow(source, this.head.row);
    this.head.col = nearestColumn(source, this.head.row, this.head.col);
    if (this.anchor) {
      this.anchor.row = clampRow(source, this.anchor.row);
      this.anchor.col = nearestColumn(source, this.anchor.row, this.anchor.col);
    }
    this.preferredCol = this.head.col;
  }

  startSelection(kind: VimSelectionKind): void {
    this.anchor = clonePoint(this.head);
    this.selectionKind = kind;
    this.clearPending();
  }

  cancelSelection(): void {
    this.anchor = undefined;
    this.selectionKind = undefined;
    this.clearPending();
  }

  handleKey(key: string, source: VimTextSource): VimHandleResult {
    if (source.lineCount <= 0) return { handled: true };

    if (key === "escape") {
      this.clearPending();
      if (this.isSelecting()) {
        this.cancelSelection();
        return { handled: true };
      }
      return { handled: true, command: "exit" };
    }

    if (this.pending?.kind === "find") {
      const pending = this.pending;
      this.pending = undefined;
      if (key.length === 0) {
        this.countBuffer = "";
        return { handled: true };
      }
      const find: FindState = {
        char: key,
        direction: pending.direction,
        till: pending.till,
      };
      const count = this.takeCount();
      this.lastFind = find;
      this.moveTo(findOnLine(source, this.head, find, count), source);
      return { handled: true };
    }

    if (this.pending?.kind === "text-object") {
      const pending = this.pending;
      this.pending = undefined;
      const range = textObjectRange(
        source,
        this.head,
        key,
        pending.around,
        this.takeCount(),
      );
      if (range) this.selectRange(range);
      return { handled: true };
    }

    if (this.pending?.kind === "g") {
      this.pending = undefined;
      if (key === "g") {
        const count = this.takeCount(false);
        const row = count ? Math.min(source.lineCount - 1, count - 1) : 0;
        this.moveTo(
          { row, col: firstNonWhitespaceColumn(source, row) },
          source,
        );
        return { handled: true };
      }
      if (key === "e" || key === "E") {
        const big = key === "E";
        const count = this.takeCount();
        this.moveTo(
          repeatMotion(this.head, count, (point) =>
            wordEndBackwardOnce(source, point, big),
          ),
          source,
        );
        return { handled: true };
      }
      this.countBuffer = "";
      return { handled: true };
    }

    if (/^[1-9]$/u.test(key) || (key === "0" && this.countBuffer.length > 0)) {
      this.countBuffer += key;
      return { handled: true };
    }

    if (key === "v") {
      if (this.isSelecting()) this.cancelSelection();
      else this.startSelection("character");
      return { handled: true };
    }

    if (key === "V") {
      this.startSelection("line");
      return { handled: true };
    }

    if (key === "y" || key === "c") {
      this.clearPending();
      return { handled: true, command: "copy" };
    }

    if (key === "enter") {
      this.clearPending();
      return { handled: true, command: "open-link" };
    }

    if (key === ":") {
      this.clearPending();
      return { handled: true, command: "ex" };
    }

    if (key === "o") {
      if (this.anchor && this.selectionKind) {
        const previousHead = this.head;
        this.head = this.anchor;
        this.anchor = previousHead;
        this.preferredCol = this.head.col;
      }
      this.clearPending();
      return { handled: true };
    }

    if (key === "i" || key === "a") {
      this.pending = { kind: "text-object", around: key === "a" };
      return { handled: true };
    }

    if (key === "g") {
      this.pending = { kind: "g" };
      return { handled: true };
    }

    if (key === "f" || key === "F" || key === "t" || key === "T") {
      this.pending = {
        kind: "find",
        direction: key === "f" || key === "t" ? 1 : -1,
        till: key === "t" || key === "T",
      };
      return { handled: true };
    }

    if (key === ";" || key === ",") {
      if (this.lastFind) {
        const count = this.takeCount();
        const find =
          key === ";"
            ? this.lastFind
            : { ...this.lastFind, direction: (-this.lastFind.direction) as -1 | 1 };
        this.moveTo(findOnLine(source, this.head, find, count), source);
      } else {
        this.countBuffer = "";
      }
      return { handled: true };
    }

    if (key === "G") {
      const explicit = this.countBuffer ? Number(this.countBuffer) : undefined;
      this.countBuffer = "";
      const row = explicit
        ? Math.min(source.lineCount - 1, Math.max(0, explicit - 1))
        : source.lineCount - 1;
      this.moveTo(
        { row, col: firstNonWhitespaceColumn(source, row) },
        source,
      );
      return { handled: true };
    }

    if (key === "%") {
      const percent = this.countBuffer ? Number(this.countBuffer) : undefined;
      this.countBuffer = "";
      if (percent !== undefined) {
        const clampedPercent = Math.max(1, Math.min(100, percent));
        const row = Math.min(
          source.lineCount - 1,
          Math.max(0, Math.ceil((source.lineCount * clampedPercent) / 100) - 1),
        );
        this.moveTo(
          { row, col: firstNonWhitespaceColumn(source, row) },
          source,
        );
      } else {
        const match = matchingBracket(source, this.head);
        if (match) this.moveTo(match, source);
      }
      return { handled: true };
    }

    const count = this.takeCount();

    if (key === "h" || key === "l") {
      const direction: -1 | 1 = key === "h" ? -1 : 1;
      const cells = lineCells(source, this.head.row);
      if (cells.length > 0) {
        const current = cellIndexAt(cells, this.head.col);
        const target = Math.max(
          0,
          Math.min(cells.length - 1, current + direction * count),
        );
        this.moveTo(
          { row: this.head.row, col: cells[target]?.start ?? this.head.col },
          source,
        );
      }
      return { handled: true };
    }

    if (key === "j" || key === "k") {
      const direction: -1 | 1 = key === "j" ? 1 : -1;
      const row = clampRow(source, this.head.row + direction * count);
      const preferred = this.preferredCol;
      this.head = { row, col: nearestColumn(source, row, preferred) };
      return { handled: true };
    }

    if (key === "0") {
      this.moveTo(lineStart(source, this.head.row), source);
      return { handled: true };
    }

    if (key === "^") {
      this.moveTo(
        {
          row: this.head.row,
          col: firstNonWhitespaceColumn(source, this.head.row),
        },
        source,
      );
      return { handled: true };
    }

    if (key === "$") {
      this.moveTo(lineEnd(source, this.head.row), source);
      return { handled: true };
    }

    if (key === "w" || key === "W") {
      const big = key === "W";
      this.moveTo(
        repeatMotion(this.head, count, (point) =>
          wordForwardOnce(source, point, big),
        ),
        source,
      );
      return { handled: true };
    }

    if (key === "b" || key === "B") {
      const big = key === "B";
      this.moveTo(
        repeatMotion(this.head, count, (point) =>
          wordBackwardOnce(source, point, big),
        ),
        source,
      );
      return { handled: true };
    }

    if (key === "e" || key === "E") {
      const big = key === "E";
      this.moveTo(
        repeatMotion(this.head, count, (point) => wordEndOnce(source, point, big)),
        source,
      );
      return { handled: true };
    }

    if (key === "{" || key === "}") {
      this.moveTo(
        paragraphMotion(source, this.head, key === "{" ? -1 : 1, count),
        source,
      );
      return { handled: true };
    }

    this.countBuffer = "";
    return { handled: false };
  }

  private moveTo(point: VimPoint, source: VimTextSource): void {
    this.head = {
      row: clampRow(source, point.row),
      col: nearestColumn(source, point.row, point.col),
    };
    this.preferredCol = this.head.col;
  }

  private selectRange(range: PointRange): void {
    this.anchor = clonePoint(range.start);
    this.head = clonePoint(range.end);
    this.selectionKind = "character";
    this.preferredCol = this.head.col;
  }

  private takeCount(defaultToOne = true): number {
    const count = this.countBuffer ? Number(this.countBuffer) : undefined;
    this.countBuffer = "";
    return count ?? (defaultToOne ? 1 : 0);
  }

  private clearPending(): void {
    this.countBuffer = "";
    this.pending = undefined;
  }

  private pendingLabel(): string {
    const count = this.countBuffer;
    if (!this.pending) return count;
    if (this.pending.kind === "g") return `${count}g`;
    if (this.pending.kind === "find") {
      const key = this.pending.direction > 0
        ? this.pending.till
          ? "t"
          : "f"
        : this.pending.till
          ? "T"
          : "F";
      return `${count}${key}`;
    }
    return `${count}${this.pending.around ? "a" : "i"}`;
  }
}
