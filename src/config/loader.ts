import { cosmiconfig } from "cosmiconfig";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import os from "os";
import { DEFAULT_CONFIG, type RiteConfig } from "./types.js";

function loadJsonFile(filePath: string): Partial<RiteConfig> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Partial<RiteConfig>;
  } catch {
    return {};
  }
}

export async function loadConfig(): Promise<RiteConfig> {
  const globalConfigPath = join(os.homedir(), ".rite", "config.json");
  const projectConfigPath = join(process.cwd(), ".rite", "config.json");

  const globalConfig = loadJsonFile(globalConfigPath);
  const projectConfig = loadJsonFile(projectConfigPath);

  const explorer = cosmiconfig("rite");
  let cosmicConfig: Partial<RiteConfig> = {};
  try {
    const result = await explorer.search();
    if (result?.config) {
      cosmicConfig = result.config as Partial<RiteConfig>;
    }
  } catch {
    // no cosmiconfig found, that's fine
  }

  return {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...cosmicConfig,
    ...projectConfig,
  };
}
