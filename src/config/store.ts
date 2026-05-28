import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import os from "os";
import { DEFAULT_CONFIG, type BackendName, type RiteConfig } from "./types.js";

export type ConfigScope = "global" | "project";

export interface ConfigPatch {
  backend?: BackendName;
  utilityBackend?: BackendName;
  historyLimit?: number;
  tokenBudget?: number;
  anthropicApiKey?: string;
}

function scopeDir(scope: ConfigScope): string {
  return scope === "global" ? join(os.homedir(), ".rite") : join(process.cwd(), ".rite");
}

export function configPath(scope: ConfigScope): string {
  return join(scopeDir(scope), "config.json");
}

export function readConfig(scope: ConfigScope): Partial<RiteConfig> {
  const filePath = configPath(scope);
  if (!existsSync(filePath)) return {};

  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Partial<RiteConfig>;
  } catch {
    return {};
  }
}

export function writeConfig(scope: ConfigScope, config: Partial<RiteConfig>): void {
  const dir = scopeDir(scope);
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(scope), JSON.stringify(config, null, 2), "utf-8");
}

export function updateConfig(scope: ConfigScope, patch: ConfigPatch): RiteConfig {
  const current = {
    ...DEFAULT_CONFIG,
    ...readConfig(scope),
  };

  const next = {
    ...current,
    ...patch,
  };

  writeConfig(scope, next);
  return next;
}
