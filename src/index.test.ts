import assert from "node:assert/strict";
import test from "node:test";

import { stripTerminalSequences } from "@earendil-works/pi-tui";
import transcriptFocus from "./index.ts";

type Handler = (...args: any[]) => any;

type HarnessOptions = {
  mode?: "fullscreen" | "inline";
  withEditor?: boolean;
  initialScrollTop?: number;
  viewportHeight?: number;
};

class FakeContainer {
  children: any[];

  constructor(children: any[] = []) {
    this.children = children;
  }

  render(width: number): string[] {
    return this.children.flatMap((child) => child.render(width));
  }

  invalidate(): void {}
}

class FakeText {
  private readonly lines: string[];
  renderCount = 0;

  constructor(lines: string[]) {
    this.lines = lines;
  }

  render(_width: number): string[] {
    this.renderCount++;
    return [...this.lines];
  }

  invalidate(): void {}
}

class Spacer extends FakeText {
  constructor(lines = 1) {
    super(Array.from({ length: lines }, () => ""));
  }
}

class UserMessageComponent extends FakeText {
  constructor(text: string) {
    super([`\x1b[48;2;47;47;61m ${text}\x1b[0m`]);
  }
}

class AssistantMessageComponent extends FakeText {
  constructor(text?: string) {
    super(text ? [` ${text}`] : []);
  }
}

class ToolExecutionComponent extends FakeText {
  toolCallId: string;

  constructor(toolCallId: string, text: string) {
    super(["", ` ${text}`]);
    this.toolCallId = toolCallId;
  }
}

function createTranscriptTree() {
  const prompt = new UserMessageComponent("hello");
  const reply = new AssistantMessageComponent("hi, how can i help?");
  const updatePrompt = new UserMessageComponent("update the file");
  const invisibleToolAssistant = new AssistantMessageComponent();
  const glob = new ToolExecutionComponent(
    "tool-glob",
    "Glob | (path=/Users/phil/.config/crush)",
  );
  const edit = new ToolExecutionComponent(
    "tool-edit",
    "Edit | ~/.config/crush/crushrc",
  );
  const done = new AssistantMessageComponent("Done. Edited file");

  const chat = new FakeContainer([
    prompt,
    new Spacer(),
    reply,
    new Spacer(),
    updatePrompt,
    invisibleToolAssistant,
    glob,
    edit,
    done,
  ]);
  const document = new FakeContainer([
    new FakeText(["header"]),
    new FakeContainer(),
    chat,
  ]);

  return {
    document,
    chat,
    prompt,
    reply,
    updatePrompt,
    invisibleToolAssistant,
    glob,
    edit,
    done,
  };
}

function createHarness(options: HarnessOptions = {}) {
  const handlers = new Map<string, Handler>();
  const statuses = new Map<string, string | undefined>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const editorInputs: string[] = [];
  const focusHistory: unknown[] = [];
  const scrollBy: number[] = [];
  const scrollTo: number[] = [];
  let scrollTopCalls = 0;
  let scrollBottomCalls = 0;
  let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let editorFactory: Handler | undefined;
  let focusedComponent: unknown = null;
  let overlay = false;
  let unsubscribed = false;
  let invalidations = 0;
  let renderRequests = 0;

  const transcript = createTranscriptTree();

  const editor = {
    handleInput(data: string) {
      editorInputs.push(data);
    },
    getMode() {
      return "normal";
    },
  };

  const maxScrollTop = 7;
  const privateScrollView = {
    scrollTop: options.initialScrollTop ?? maxScrollTop,
    viewportHeight: options.viewportHeight ?? 4,
    getContentWidth(width: number) {
      return width;
    },
    scrollTo(row: number) {
      this.scrollTop = Math.max(0, Math.min(maxScrollTop, row));
      scrollTo.push(this.scrollTop);
    },
  };

  const tui = {
    mode: options.mode ?? "fullscreen",
    terminal: { rows: 30, columns: 100 },
    children: [
      transcript.document,
      new FakeContainer(),
      new FakeContainer(),
      new FakeContainer(),
      new FakeContainer(),
    ],
    currentLayout: { primaryScrollView: privateScrollView },
    get viewportTop() {
      return privateScrollView.scrollTop;
    },
    setFocus(component: unknown) {
      focusedComponent = component;
      focusHistory.push(component);
    },
    getFocusedComponent() {
      return focusedComponent;
    },
    hasOverlay() {
      return overlay;
    },
    scrollBy(lines: number) {
      scrollBy.push(lines);
      privateScrollView.scrollTop = Math.max(
        0,
        Math.min(maxScrollTop, privateScrollView.scrollTop + lines),
      );
    },
    scrollToTop() {
      scrollTopCalls++;
      privateScrollView.scrollTop = 0;
    },
    scrollToBottom() {
      scrollBottomCalls++;
      privateScrollView.scrollTop = maxScrollTop;
    },
    invalidate() {
      invalidations++;
    },
    requestRender() {
      renderRequests++;
    },
  };

  const previousFactory = options.withEditor === false ? undefined : () => editor;
  const ctx = {
    ui: {
      getEditorComponent: () => previousFactory,
      setEditorComponent(factory: Handler) {
        editorFactory = factory;
      },
      onTerminalInput(handler: typeof terminalHandler) {
        terminalHandler = handler;
        return () => {
          unsubscribed = true;
          terminalHandler = undefined;
        };
      },
      setStatus(key: string, text: string | undefined) {
        statuses.set(key, text);
      },
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  };

  transcriptFocus({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  } as any);

  const start = () => {
    handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    if (editorFactory) {
      const installedEditor = editorFactory(tui, {}, {});
      focusedComponent = installedEditor;
    }
  };

  const input = (data: string) => {
    const result = terminalHandler?.(data);
    if (!result?.consume && focusedComponent === editor) editor.handleInput(data);
    return result;
  };

  const shutdown = () => {
    handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
  };

  const renderedTranscriptLine = (component: FakeText): string => {
    const needle = component
      .render(98)
      .map((candidate) => stripTerminalSequences(candidate))
      .find((candidate) => candidate.trim().length > 0)
      ?.trim();
    if (!needle) return "";

    return (
      transcript.document
        .render(100)
        .find((candidate) => stripTerminalSequences(candidate).includes(needle)) ?? ""
    );
  };

  const renderedFirstVisibleLine = (component: FakeText): string => {
    const line = stripTerminalSequences(renderedTranscriptLine(component));
    // Most tests only care that a selection marker is present; normalize the
    // heavy production glyph to the legacy marker used by those assertions.
    return line.replace(/^┃/u, "│");
  };

  return {
    editor,
    editorInputs,
    focusHistory,
    input,
    notifications,
    renderedFirstVisibleLine,
    renderedTranscriptLine,
    scrollBy,
    scrollTo,
    setOverlay(value: boolean) {
      overlay = value;
    },
    shutdown,
    start,
    statuses,
    transcript,
    transcriptRenderCount() {
      return [
        transcript.prompt,
        transcript.reply,
        transcript.updatePrompt,
        transcript.invisibleToolAssistant,
        transcript.glob,
        transcript.edit,
        transcript.done,
      ].reduce((total, component) => total + component.renderCount, 0);
    },
    privateScrollView,
    get focusedComponent() {
      return focusedComponent;
    },
    get scrollTopCalls() {
      return scrollTopCalls;
    },
    get scrollBottomCalls() {
      return scrollBottomCalls;
    },
    get unsubscribed() {
      return unsubscribed;
    },
    get invalidations() {
      return invalidations;
    },
    get renderRequests() {
      return renderRequests;
    },
  };
}

test("Tab selects the bottom visible item and re-entry preserves a visible selection", () => {
  const h = createHarness();
  h.start();

  assert.deepEqual(h.input("\t"), { consume: true });
  assert.equal(h.focusedComponent, null);
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /message 6\/6/);
  assert.match(h.renderedFirstVisibleLine(h.transcript.done), /^│/);

  assert.deepEqual(h.input("\t"), { consume: true });
  assert.equal(h.focusedComponent, h.editor);
  assert.equal(h.statuses.get("pi-tab-focus"), undefined);
  assert.doesNotMatch(h.renderedFirstVisibleLine(h.transcript.done), /^│/);

  h.input("\t");
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /message 6\/6/);
  assert.match(h.renderedFirstVisibleLine(h.transcript.done), /^│/);

  assert.deepEqual(h.input("\x1b"), { consume: true });
  assert.equal(h.focusedComponent, h.editor);
});

test("transcript navigation consumes keys and drives fullscreen scrolling", () => {
  const h = createHarness();
  h.start();
  h.input("\t");

  h.input("j");
  h.input("k");
  h.input("b");
  h.input("f");
  h.input("g");
  h.input("G");

  assert.deepEqual(h.scrollBy, [1, -1, -25, 25]);
  assert.equal(h.scrollTopCalls, 1);
  assert.equal(h.scrollBottomCalls, 1);
  assert.deepEqual(h.editorInputs, []);
});

test("line scrolling reuses cached transcript rows while selection remains visible", () => {
  const h = createHarness({ initialScrollTop: 0 });
  h.start();
  h.input("\t");

  const rendersBeforeScroll = h.transcriptRenderCount();
  h.input("j");

  assert.equal(h.transcriptRenderCount(), rendersBeforeScroll);
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /message 2\/6/);
});

test("permanent gutter is installed before transcript focus and wraps the transcript once", () => {
  const h = createHarness({ initialScrollTop: 0 });
  h.start();

  // The gutter is part of the default transcript layout; Tab must not be needed
  // to install it or move transcript text.
  assert.equal(Object.prototype.hasOwnProperty.call(h.transcript.chat, "render"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(h.transcript.reply, "render"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(h.transcript.prompt, "render"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(h.transcript.glob, "render"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(h.transcript.edit, "render"), false);

  h.input("\t");
  assert.equal(Object.prototype.hasOwnProperty.call(h.transcript.reply, "render"), true);
});

test("scrolling up follows the bottom viewport edge and auto-selects user prompts", () => {
  const h = createHarness({ initialScrollTop: 7 });
  h.start();
  h.input("\t");

  assert.match(h.statuses.get("pi-tab-focus") ?? "", /message 6\/6/);

  h.input("k");
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /tool 5\/6/);

  h.input("k");
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /tool 4\/6/);

  h.input("k");
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /tool 4\/6/);

  h.input("k");
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /prompt 3\/6/);
  assert.match(h.renderedFirstVisibleLine(h.transcript.updatePrompt), /^│/);
});

test("scrolling down follows the top viewport edge and auto-selects user prompts", () => {
  const h = createHarness({ initialScrollTop: 0 });
  h.start();
  h.input("\t");

  assert.match(h.statuses.get("pi-tab-focus") ?? "", /message 2\/6/);

  h.input("j");
  h.input("j");
  h.input("j");
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /message 2\/6/);

  h.input("j");
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /prompt 3\/6/);
  assert.match(h.renderedFirstVisibleLine(h.transcript.updatePrompt), /^│/);
});

test("re-entering after the viewport moves chooses the bottom visible item", () => {
  const h = createHarness({ initialScrollTop: 0 });
  h.start();
  h.input("\t");
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /message 2\/6/);

  h.input("\t");
  h.privateScrollView.scrollTop = 7;
  h.input("\t");

  assert.match(h.statuses.get("pi-tab-focus") ?? "", /message 6\/6/);
  assert.match(h.renderedFirstVisibleLine(h.transcript.done), /^│/);
  assert.doesNotMatch(h.renderedFirstVisibleLine(h.transcript.reply), /^│/);
});

test("Shift navigation selects every rendered prompt, message and tool item in order", () => {
  const h = createHarness({ initialScrollTop: 0 });
  h.start();
  h.input("\t");

  // At the top viewport, Tab chooses the bottom-most visible item (the reply).
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /message 2\/6/);

  h.input("K");
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /prompt 1\/6/);
  assert.match(h.renderedFirstVisibleLine(h.transcript.prompt), /^│/);

  const expectedForward = [
    [h.transcript.reply, /message 2\/6/],
    [h.transcript.updatePrompt, /prompt 3\/6/],
    [h.transcript.glob, /tool 4\/6/],
    [h.transcript.edit, /tool 5\/6/],
    [h.transcript.done, /message 6\/6/],
  ] as const;

  for (const [component, status] of expectedForward) {
    assert.deepEqual(h.input("J"), { consume: true });
    assert.match(h.statuses.get("pi-tab-focus") ?? "", status);
    assert.match(h.renderedFirstVisibleLine(component), /^│/);
  }

  assert.deepEqual(h.transcript.invisibleToolAssistant.render(100), []);

  h.input("K");
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /tool 5\/6/);
  assert.match(h.renderedFirstVisibleLine(h.transcript.edit), /^│/);
  assert.doesNotMatch(h.renderedFirstVisibleLine(h.transcript.done), /^│/);
});

test("transcript gutter is permanently reserved and selection never moves text", () => {
  const h = createHarness({ initialScrollTop: 0 });
  h.start();

  // The gutter already exists before transcript mode. Glob is unselected here.
  const unselectedGlob = h.renderedTranscriptLine(h.transcript.glob);
  assert.match(stripTerminalSequences(unselectedGlob), /^   Glob \|/);

  h.input("\t");
  h.input("J");
  h.input("J");

  const selectedGlob = h.renderedTranscriptLine(h.transcript.glob);
  assert.match(stripTerminalSequences(selectedGlob), /^┃  Glob \|/);
  assert.equal(
    stripTerminalSequences(selectedGlob).slice(1),
    stripTerminalSequences(unselectedGlob).slice(1),
  );
  assert.match(selectedGlob, /\x1b\[38;2;92;196;147m┃/);

  h.input("K");
  h.input("K");
  h.input("K");
  const selectedPrompt = h.renderedTranscriptLine(h.transcript.prompt);
  assert.match(stripTerminalSequences(selectedPrompt), /^┃  hello/);
  assert.match(selectedPrompt, /\x1b\[38;2;255;121;198m┃/);
  assert.ok((selectedPrompt.match(/\x1b\[48;2;47;47;61m/g) ?? []).length >= 2);

  h.input("\t");
  const unselectedPrompt = h.renderedTranscriptLine(h.transcript.prompt);
  assert.match(stripTerminalSequences(unselectedPrompt), /^   hello/);
  assert.equal(
    stripTerminalSequences(selectedPrompt).slice(1),
    stripTerminalSequences(unselectedPrompt).slice(1),
  );
});

test("item navigation uses the private fullscreen viewport only to reveal offscreen selection", () => {
  const h = createHarness({ initialScrollTop: 0 });
  h.start();
  h.input("\t");

  h.input("J");

  assert.ok(h.scrollTo.length > 0);
  assert.ok(h.privateScrollView.scrollTop > 0);
});

test(": temporarily enters pi-vim EX and preserves the selected item on return", async () => {
  const h = createHarness({ initialScrollTop: 0 });
  h.start();
  h.input("\t");

  assert.match(h.renderedFirstVisibleLine(h.transcript.reply), /^│/);
  assert.deepEqual(h.input(":"), { consume: true });
  assert.equal(h.focusedComponent, h.editor);
  assert.deepEqual(h.editorInputs, [":"]);
  assert.match(h.renderedFirstVisibleLine(h.transcript.reply), /^│/);

  assert.equal(h.input("\r"), undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(h.editorInputs, [":", "\r"]);
  assert.equal(h.focusedComponent, null);
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /message 2\/6/);
  assert.match(h.renderedFirstVisibleLine(h.transcript.reply), /^│/);
});

test("Tab during EX cancels back to transcript focus without autocomplete", () => {
  const h = createHarness({ initialScrollTop: 0 });
  h.start();
  h.input("\t");
  h.input(":");

  assert.deepEqual(h.input("\t"), { consume: true });
  assert.deepEqual(h.editorInputs, [":", "\x1b"]);
  assert.equal(h.focusedComponent, null);
  assert.match(h.renderedFirstVisibleLine(h.transcript.reply), /^│/);
});

test("leaving transcript mode hides but preserves the logical selection", () => {
  const h = createHarness({ initialScrollTop: 0 });
  h.start();
  h.input("\t");
  assert.match(h.renderedFirstVisibleLine(h.transcript.reply), /^│/);

  h.input("\t");
  assert.doesNotMatch(h.renderedFirstVisibleLine(h.transcript.reply), /^│/);

  h.input("\t");
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /message 2\/6/);
  assert.match(h.renderedFirstVisibleLine(h.transcript.reply), /^│/);
});

test("session shutdown removes input handling, decoration and restores editor focus", () => {
  const h = createHarness({ initialScrollTop: 0 });
  h.start();
  h.input("\t");
  assert.equal(h.focusedComponent, null);
  assert.match(h.renderedFirstVisibleLine(h.transcript.reply), /^│/);

  h.shutdown();

  assert.equal(h.unsubscribed, true);
  assert.equal(h.focusedComponent, h.editor);
  assert.equal(h.statuses.get("pi-tab-focus"), undefined);
  assert.doesNotMatch(h.renderedFirstVisibleLine(h.transcript.reply), /^│/);
});

test("missing pi-vim and non-fullscreen mode fail safely", () => {
  const missing = createHarness({ withEditor: false });
  missing.start();
  assert.match(missing.notifications[0]?.message ?? "", /listed after pi-vim/);

  const inline = createHarness({ mode: "inline" });
  inline.start();
  assert.deepEqual(inline.input("\t"), { consume: true });
  assert.match(inline.notifications[0]?.message ?? "", /fullscreen mode/);
  assert.equal(inline.statuses.get("pi-tab-focus"), undefined);
});
