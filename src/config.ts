import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Key, type KeyId } from "@earendil-works/pi-tui";

type ConfigContext = {
  cwd: string;
  isProjectTrusted(): boolean;
};

type ResolvedConfig = {
  focusKey: KeyId;
  hideDefaultScrollIndicator: boolean;
  warnings: string[];
};

type PartialConfig = {
  focusKey?: KeyId;
  hideDefaultScrollIndicator?: boolean;
  warnings: string[];
};

const CONFIG_FILE = "pi-tab-focus.json";
const DEFAULT_FOCUS_KEY: KeyId = Key.tab;
const DEFAULT_HIDE_DEFAULT_SCROLL_INDICATOR = true;

function readConfig(path: string): PartialConfig {
  if (!existsSync(path)) return { warnings: [] };

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        warnings: [`Invalid ${CONFIG_FILE}: expected a JSON object (${path}).`],
      };
    }

    const config = parsed as Record<string, unknown>;
    const result: PartialConfig = { warnings: [] };

    const focusKey = config.focusKey;
    if (focusKey !== undefined) {
      if (typeof focusKey !== "string" || focusKey.length === 0) {
        result.warnings.push(
          `Invalid focusKey in ${path}; using the previous/default binding.`,
        );
      } else {
        result.focusKey = focusKey as KeyId;
      }
    }

    const hideDefaultScrollIndicator = config.hideDefaultScrollIndicator;
    if (hideDefaultScrollIndicator !== undefined) {
      if (typeof hideDefaultScrollIndicator !== "boolean") {
        result.warnings.push(
          `Invalid hideDefaultScrollIndicator in ${path}; using the previous/default value.`,
        );
      } else {
        result.hideDefaultScrollIndicator = hideDefaultScrollIndicator;
      }
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { warnings: [`Could not read ${path}: ${message}`] };
  }
}

export function resolveConfig(
  ctx: ConfigContext,
  agentDir: string,
): ResolvedConfig {
  let focusKey = DEFAULT_FOCUS_KEY;
  let hideDefaultScrollIndicator = DEFAULT_HIDE_DEFAULT_SCROLL_INDICATOR;
  const warnings: string[] = [];

  const globalConfig = readConfig(join(agentDir, CONFIG_FILE));
  if (globalConfig.focusKey) focusKey = globalConfig.focusKey;
  if (globalConfig.hideDefaultScrollIndicator !== undefined) {
    hideDefaultScrollIndicator = globalConfig.hideDefaultScrollIndicator;
  }
  warnings.push(...globalConfig.warnings);

  if (ctx.isProjectTrusted()) {
    const projectConfig = readConfig(join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE));
    if (projectConfig.focusKey) focusKey = projectConfig.focusKey;
    if (projectConfig.hideDefaultScrollIndicator !== undefined) {
      hideDefaultScrollIndicator = projectConfig.hideDefaultScrollIndicator;
    }
    warnings.push(...projectConfig.warnings);
  }

  return { focusKey, hideDefaultScrollIndicator, warnings };
}
