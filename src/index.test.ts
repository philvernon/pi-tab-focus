import assert from "node:assert/strict";
import test from "node:test";

import transcriptFocus from "./index.ts";

type Handler = (...args: any[]) => any;

type HarnessOptions = {
  mode?: "fullscreen" | "inline";
  withEditor?: boolean;
  branch?: Array<{ type: string; id: string; message?: unknown }>;
};

function createHarness(options: HarnessOptions = {}) {
  const handlers = new Map<string, Handler>();
  const statuses = new Map<string, string | undefined>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const editorInputs: string[] = [];
  const focusHistory: unknown[] = [];
  const scrollBy: number[] = [];
  const promptJumps: number[] = [];
  let scrollTop = 0;
  let scrollBottom = 0;
  let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let editorFactory: Handler | undefined;
  let focusedComponent: unknown = null;
  let overlay = false;
  let unsubscribed = false;

  const editor = {
    handleInput(data: string) {
      editorInputs.push(data);
    },
    getMode() {
      return "normal";
    },
  };

  const tui = {
    mode: options.mode ?? "fullscreen",
    terminal: { rows: 30, columns: 100 },
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
    },
    scrollToTop() {
      scrollTop++;
    },
    scrollToBottom() {
      scrollBottom++;
    },
    scrollToPrompt(direction: number) {
      promptJumps.push(direction);
    },
  };

  const previousFactory = options.withEditor === false ? undefined : () => editor;
  const ctx = {
    sessionManager: {
      getBranch: () => options.branch ?? [],
    },
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

  return {
    editor,
    editorInputs,
    focusHistory,
    input,
    notifications,
    promptJumps,
    scrollBy,
    setOverlay(value: boolean) {
      overlay = value;
    },
    shutdown,
    start,
    statuses,
    get focusedComponent() {
      return focusedComponent;
    },
    get scrollTop() {
      return scrollTop;
    },
    get scrollBottom() {
      return scrollBottom;
    },
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

test("Tab enters transcript focus and Tab/Escape restore the editor", () => {
  const h = createHarness();
  h.start();

  assert.deepEqual(h.input("\t"), { consume: true });
  assert.equal(h.focusedComponent, null);
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /^TRANSCRIPT /);

  assert.deepEqual(h.input("\t"), { consume: true });
  assert.equal(h.focusedComponent, h.editor);
  assert.equal(h.statuses.get("pi-tab-focus"), undefined);

  h.input("\t");
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
  assert.equal(h.scrollTop, 1);
  assert.equal(h.scrollBottom, 1);
  assert.deepEqual(h.editorInputs, []);
});

test("prompt navigation tracks user prompts and calls Pi's semantic prompt jump", () => {
  const h = createHarness({
    branch: [
      { type: "message", id: "u1", message: { role: "user", content: "one" } },
      { type: "message", id: "a1", message: { role: "assistant", content: "answer" } },
      { type: "message", id: "u2", message: { role: "user", content: [{ type: "text", text: "two" }] } },
    ],
  });
  h.start();
  h.input("\t");

  h.input("J");
  assert.deepEqual(h.promptJumps, [1]);
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /prompt 1\/2/);

  h.input("J");
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /prompt 2\/2/);

  h.input("K");
  assert.deepEqual(h.promptJumps, [1, 1, -1]);
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /prompt 1\/2/);
});

test(": temporarily enters pi-vim EX and Tab cancels back to transcript focus", () => {
  const h = createHarness();
  h.start();
  h.input("\t");

  assert.deepEqual(h.input(":"), { consume: true });
  assert.equal(h.focusedComponent, h.editor);
  assert.deepEqual(h.editorInputs, [":"]);

  assert.deepEqual(h.input("\t"), { consume: true });
  assert.deepEqual(h.editorInputs, [":", "\x1b"]);
  assert.equal(h.focusedComponent, null);
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /^TRANSCRIPT /);
});

test("submitting an EX command returns to transcript focus", async () => {
  const h = createHarness();
  h.start();
  h.input("\t");
  h.input(":");

  assert.equal(h.input("\r"), undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(h.editorInputs, [":", "\r"]);
  assert.equal(h.focusedComponent, null);
  assert.match(h.statuses.get("pi-tab-focus") ?? "", /^TRANSCRIPT /);
});

test("session shutdown removes input handling and restores editor focus", () => {
  const h = createHarness();
  h.start();
  h.input("\t");
  assert.equal(h.focusedComponent, null);

  h.shutdown();

  assert.equal(h.unsubscribed, true);
  assert.equal(h.focusedComponent, h.editor);
  assert.equal(h.statuses.get("pi-tab-focus"), undefined);
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
