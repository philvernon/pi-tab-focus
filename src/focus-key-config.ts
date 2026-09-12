import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Key, type KeyId } from "@earendil-works/pi-tui";

type FocusKeyConfigContext = {
  cwd: string;
  isProjectTrusted(): boolean;
};

type FocusKeyResolution = {
  key: KeyId;
  warnings: string[];
};

const FOCUS_CONFIG_FILE = "pi-tab-focus.json";
const DEFAULT_FOCUS_KEY: KeyId = Key.tab;

function readFocusKeyConfig(path: string): {
  key?: KeyId;
  warning?: string;
} {
  if (!existsSync(path)) return {};

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        warning: `Invalid ${FOCUS_CONFIG_FILE}: expected a JSON object (${path}).`,
      };
    }

    const value = (parsed as Record<string, unknown>).focusKey;
    if (value === undefined) return {};
    if (typeof value !== "string" || value.length === 0) {
      return {
        warning: `Invalid focusKey in ${path}; using the previous/default binding.`,
      };
    }

    return { key: value as KeyId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { warning: `Could not read ${path}: ${message}` };
  }
}

export function resolveFocusKey(
  ctx: FocusKeyConfigContext,
  agentDir: string,
): FocusKeyResolution {
  let key = DEFAULT_FOCUS_KEY;
  const warnings: string[] = [];

  const globalConfig = readFocusKeyConfig(join(agentDir, FOCUS_CONFIG_FILE));
  if (globalConfig.key) key = globalConfig.key;
  if (globalConfig.warning) warnings.push(globalConfig.warning);

  if (ctx.isProjectTrusted()) {
    const projectConfig = readFocusKeyConfig(
      join(ctx.cwd, CONFIG_DIR_NAME, FOCUS_CONFIG_FILE),
    );
    if (projectConfig.key) key = projectConfig.key;
    if (projectConfig.warning) warnings.push(projectConfig.warning);
  }

  return { key, warnings };
}
