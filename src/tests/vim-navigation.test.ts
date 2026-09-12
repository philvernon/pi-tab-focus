import assert from "node:assert/strict";
import test from "node:test";

import {
  VimVisualNavigation,
  type VimCell,
  type VimTextSource,
} from "../vim-navigation.ts";

function source(lines: string[]): VimTextSource {
  const rows = lines.map((line) => {
    let col = 0;
    return Array.from(line, (text): VimCell => {
      const cell = { start: col, end: col + 1, text };
      col++;
      return cell;
    });
  });
  return {
    lineCount: rows.length,
    line: (row) => rows[row] ?? [],
  };
}

function press(
  navigation: VimVisualNavigation,
  text: VimTextSource,
  ...keys: string[]
): void {
  for (const key of keys) navigation.handleKey(key, text);
}

test("word motions distinguish Vim words from WORDs and accept counts", () => {
  const text = source(["one,two three"]);

  const small = new VimVisualNavigation({ row: 0, col: 0 });
  press(small, text, "w");
  assert.deepEqual(small.snapshot().head, { row: 0, col: 3 });
  press(small, text, "w");
  assert.deepEqual(small.snapshot().head, { row: 0, col: 4 });
  press(small, text, "e");
  assert.deepEqual(small.snapshot().head, { row: 0, col: 6 });
  press(small, text, "b");
  assert.deepEqual(small.snapshot().head, { row: 0, col: 4 });

  const counted = new VimVisualNavigation({ row: 0, col: 0 });
  press(counted, text, "2", "w");
  assert.deepEqual(counted.snapshot().head, { row: 0, col: 4 });

  const big = new VimVisualNavigation({ row: 0, col: 0 });
  press(big, text, "W");
  assert.deepEqual(big.snapshot().head, { row: 0, col: 8 });
  press(big, text, "B");
  assert.deepEqual(big.snapshot().head, { row: 0, col: 0 });
});

test("ge and gE move to the previous word and WORD end", () => {
  const text = source(["one,two three"]);

  const small = new VimVisualNavigation({ row: 0, col: 4 });
  press(small, text, "g", "e");
  assert.deepEqual(small.snapshot().head, { row: 0, col: 3 });

  const big = new VimVisualNavigation({ row: 0, col: 8 });
  press(big, text, "g", "E");
  assert.deepEqual(big.snapshot().head, { row: 0, col: 6 });
});

test("find motions remember their target for semicolon and comma", () => {
  const text = source(["a,b,c,d"]);
  const navigation = new VimVisualNavigation({ row: 0, col: 0 });

  press(navigation, text, "f", ",");
  assert.deepEqual(navigation.snapshot().head, { row: 0, col: 1 });
  press(navigation, text, ";");
  assert.deepEqual(navigation.snapshot().head, { row: 0, col: 3 });
  press(navigation, text, ",");
  assert.deepEqual(navigation.snapshot().head, { row: 0, col: 1 });

  const till = new VimVisualNavigation({ row: 0, col: 0 });
  press(till, text, "t", "d");
  assert.deepEqual(till.snapshot().head, { row: 0, col: 5 });
});

test("percent matches brackets and counted percent jumps by document percentage", () => {
  const text = source(["call(foo[bar])", "middle", "last"]);
  const navigation = new VimVisualNavigation({ row: 0, col: 4 });

  press(navigation, text, "%");
  assert.deepEqual(navigation.snapshot().head, { row: 0, col: 13 });
  press(navigation, text, "%");
  assert.deepEqual(navigation.snapshot().head, { row: 0, col: 4 });

  press(navigation, text, "5", "0", "%");
  assert.deepEqual(navigation.snapshot().head, { row: 1, col: 0 });
});

test("gg, counted G and G navigate by document line", () => {
  const text = source(["  first", " second", "third"]);
  const navigation = new VimVisualNavigation({ row: 2, col: 3 });

  press(navigation, text, "g", "g");
  assert.deepEqual(navigation.snapshot().head, { row: 0, col: 2 });

  press(navigation, text, "2", "G");
  assert.deepEqual(navigation.snapshot().head, { row: 1, col: 1 });

  press(navigation, text, "G");
  assert.deepEqual(navigation.snapshot().head, { row: 2, col: 0 });
});

test("viw and vaw select word text objects without Pi dependencies", () => {
  const text = source(["alpha beta"]);

  const inner = new VimVisualNavigation({ row: 0, col: 2 });
  press(inner, text, "i", "w");
  assert.deepEqual(inner.snapshot(), {
    head: { row: 0, col: 4 },
    anchor: { row: 0, col: 0 },
    selectionKind: "character",
    preferredCol: 4,
    pending: "",
    count: undefined,
  });

  const around = new VimVisualNavigation({ row: 0, col: 2 });
  press(around, text, "a", "w");
  assert.deepEqual(around.snapshot().anchor, { row: 0, col: 0 });
  assert.deepEqual(around.snapshot().head, { row: 0, col: 5 });
});

test("quote and bracket text objects select inner or around delimiters", () => {
  const quoted = source(['say "hello" now']);
  const innerQuote = new VimVisualNavigation({ row: 0, col: 7 });
  press(innerQuote, quoted, "i", '"');
  assert.deepEqual(innerQuote.snapshot().anchor, { row: 0, col: 5 });
  assert.deepEqual(innerQuote.snapshot().head, { row: 0, col: 9 });

  const aroundQuote = new VimVisualNavigation({ row: 0, col: 7 });
  press(aroundQuote, quoted, "a", '"');
  assert.deepEqual(aroundQuote.snapshot().anchor, { row: 0, col: 4 });
  assert.deepEqual(aroundQuote.snapshot().head, { row: 0, col: 10 });

  const bracketed = source(["x (foo [bar]) y"]);
  const innerBracket = new VimVisualNavigation({ row: 0, col: 9 });
  press(innerBracket, bracketed, "i", "[");
  assert.deepEqual(innerBracket.snapshot().anchor, { row: 0, col: 8 });
  assert.deepEqual(innerBracket.snapshot().head, { row: 0, col: 10 });

  const aroundParen = new VimVisualNavigation({ row: 0, col: 9 });
  press(aroundParen, bracketed, "a", "(");
  assert.deepEqual(aroundParen.snapshot().anchor, { row: 0, col: 2 });
  assert.deepEqual(aroundParen.snapshot().head, { row: 0, col: 12 });
});

test("V converts an existing character selection to linewise without resetting its range", () => {
  const text = source(["alpha", "beta", "gamma"]);
  const navigation = new VimVisualNavigation({ row: 0, col: 1 });

  press(navigation, text, "v", "j", "j", "l");
  assert.deepEqual(navigation.snapshot().anchor, { row: 0, col: 1 });
  assert.deepEqual(navigation.snapshot().head, { row: 2, col: 2 });
  assert.equal(navigation.snapshot().selectionKind, "character");

  press(navigation, text, "V");
  assert.deepEqual(navigation.snapshot().anchor, { row: 0, col: 1 });
  assert.deepEqual(navigation.snapshot().head, { row: 2, col: 2 });
  assert.equal(navigation.snapshot().selectionKind, "line");
});

test("visual toggles and o remain state-machine concerns", () => {
  const text = source(["alpha beta"]);
  const navigation = new VimVisualNavigation({ row: 0, col: 0 });

  press(navigation, text, "v", "e");
  assert.deepEqual(navigation.snapshot().anchor, { row: 0, col: 0 });
  assert.deepEqual(navigation.snapshot().head, { row: 0, col: 4 });

  press(navigation, text, "o");
  assert.deepEqual(navigation.snapshot().anchor, { row: 0, col: 4 });
  assert.deepEqual(navigation.snapshot().head, { row: 0, col: 0 });

  press(navigation, text, "v");
  assert.equal(navigation.isSelecting(), false);
  assert.equal(navigation.snapshot().anchor, undefined);

  const result = navigation.handleKey("escape", text);
  assert.deepEqual(result, { handled: true, command: "exit" });
});

test("word motions cross empty rendered rows without skipping the next word", () => {
  const text = source(["alpha", "", "beta"]);
  const navigation = new VimVisualNavigation({ row: 1, col: 0 });

  press(navigation, text, "w");
  assert.deepEqual(navigation.snapshot().head, { row: 2, col: 0 });

  const end = new VimVisualNavigation({ row: 1, col: 0 });
  press(end, text, "e");
  assert.deepEqual(end.snapshot().head, { row: 2, col: 3 });
});

test("vertical and paragraph motions preserve a useful cursor column", () => {
  const text = source(["alpha beta", "", "xy", "longer line"]);
  const navigation = new VimVisualNavigation({ row: 0, col: 6 });

  press(navigation, text, "j");
  assert.deepEqual(navigation.snapshot().head, { row: 1, col: 0 });
  press(navigation, text, "j");
  assert.deepEqual(navigation.snapshot().head, { row: 2, col: 1 });

  press(navigation, text, "{");
  assert.deepEqual(navigation.snapshot().head, { row: 0, col: 0 });
  press(navigation, text, "}");
  assert.deepEqual(navigation.snapshot().head, { row: 2, col: 0 });
});
