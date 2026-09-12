import assert from "node:assert/strict";
import test from "node:test";

import { installTranscriptEditorBorderStyle } from "./fullscreen-ui.ts";

test("transcript border style preserves existing border rendering and restores inherited methods", () => {
  let transcriptFocused = false;

  class BaseEditor {
    renderTopBorder(width: number, hiddenLineCount: number): string {
      const label = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : " working ";
      const remaining = Math.max(0, width - label.length);
      return `accent(${"─".repeat(Math.floor(remaining / 2))}${label}${"─".repeat(Math.ceil(remaining / 2))})`;
    }

    renderBottomBorder(width: number): string {
      return `muted(${"─".repeat(width)})`;
    }
  }

  class CustomEditor extends BaseEditor {}

  const editor = new CustomEditor();
  assert.equal(Object.hasOwn(editor, "renderTopBorder"), false);
  assert.equal(Object.hasOwn(editor, "renderBottomBorder"), false);

  const restore = installTranscriptEditorBorderStyle(
    editor,
    () => transcriptFocused,
  );
  assert.ok(restore);

  assert.equal(
    editor.renderTopBorder(19, 0),
    `accent(${"─".repeat(5)} working ${"─".repeat(5)})`,
  );
  assert.equal(editor.renderBottomBorder(8), `muted(${"─".repeat(8)})`);

  transcriptFocused = true;
  assert.equal(
    editor.renderTopBorder(19, 0),
    `accent(${"╌".repeat(5)} working ${"╌".repeat(5)})`,
  );
  assert.equal(
    editor.renderTopBorder(20, 3),
    `accent(${"╌".repeat(5)} ↑ 3 more ${"╌".repeat(5)})`,
  );
  assert.equal(editor.renderBottomBorder(8), `muted(${"╌".repeat(8)})`);

  restore();
  assert.equal(Object.hasOwn(editor, "renderTopBorder"), false);
  assert.equal(Object.hasOwn(editor, "renderBottomBorder"), false);
  assert.equal(
    editor.renderTopBorder(19, 0),
    `accent(${"─".repeat(5)} working ${"─".repeat(5)})`,
  );
  assert.equal(editor.renderBottomBorder(8), `muted(${"─".repeat(8)})`);
});

test("transcript border style is a no-op for editors without border renderers", () => {
  const restore = installTranscriptEditorBorderStyle({}, () => true);
  assert.equal(restore, undefined);
});
