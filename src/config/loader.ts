import { cosmiconfig } from "cosmiconfig";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import os from "os";
import { DEFAULT_CONFIG, type RiteConfig } from "./types.js";
import { log } from "../utils/logger.js";

const clog = log.child("config");

function loadJsonFile(filePath: string): Partial<RiteConfig> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RiteConfig>;
    clog.debug("file.loaded", { filePath, keys: Object.keys(parsed) });
    return parsed;
  } catch (err) {
    clog.warn("file.parse.failed", { filePath, err });
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
  let cosmicSource: string | undefined;
  try {
    const result = await explorer.search();
    if (result?.config) {
      cosmicConfig = result.config as Partial<RiteConfig>;
      cosmicSource = result.filepath;
    }
  } catch (err) {
    clog.warn("cosmiconfig.search.failed", { err });
  }

  const merged = {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...cosmicConfig,
    ...projectConfig,
  };

  clog.info("loaded", {
    globalConfigPath,
    projectConfigPath,
    cosmicSource,
    backend: merged.backend,
    utilityBackend: merged.utilityBackend,
    keys: Object.keys(merged),
  });

  return merged;
}
