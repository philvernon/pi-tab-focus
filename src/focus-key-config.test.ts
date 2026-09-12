import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { resolveFocusKey } from "./focus-key-config.ts";

function withTempRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pi-tab-focus-config-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function context(cwd: string, trusted: boolean) {
  return {
    cwd,
    isProjectTrusted: () => trusted,
  };
}

test("defaults to Tab when no config exists", () => {
  withTempRoot((root) => {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");

    assert.deepEqual(resolveFocusKey(context(cwd, false), agentDir), {
      key: "tab",
      warnings: [],
    });
  });
});

test("reads a global focus key", () => {
  withTempRoot((root) => {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "pi-tab-focus.json"),
      JSON.stringify({ focusKey: "ctrl+g" }),
    );

    assert.deepEqual(resolveFocusKey(context(cwd, false), agentDir), {
      key: "ctrl+g",
      warnings: [],
    });
  });
});

test("trusted project config overrides global config", () => {
  withTempRoot((root) => {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(
      join(agentDir, "pi-tab-focus.json"),
      JSON.stringify({ focusKey: "ctrl+g" }),
    );
    writeFileSync(
      join(cwd, CONFIG_DIR_NAME, "pi-tab-focus.json"),
      JSON.stringify({ focusKey: "ctrl+t" }),
    );

    assert.deepEqual(resolveFocusKey(context(cwd, true), agentDir), {
      key: "ctrl+t",
      warnings: [],
    });
    assert.deepEqual(resolveFocusKey(context(cwd, false), agentDir), {
      key: "ctrl+g",
      warnings: [],
    });
  });
});

test("invalid config keeps the previous binding and returns a warning", () => {
  withTempRoot((root) => {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(
      join(agentDir, "pi-tab-focus.json"),
      JSON.stringify({ focusKey: "ctrl+g" }),
    );
    writeFileSync(
      join(cwd, CONFIG_DIR_NAME, "pi-tab-focus.json"),
      JSON.stringify({ focusKey: 42 }),
    );

    const result = resolveFocusKey(context(cwd, true), agentDir);
    assert.equal(result.key, "ctrl+g");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", /Invalid focusKey/);
  });
});
