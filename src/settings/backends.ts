import { updateConfig, type ConfigScope } from "../config/store.js";
import type { BackendName } from "../config/types.js";

export type BackendTarget = "assistant" | "utility";

function backendField(target: BackendTarget): "backend" | "utilityBackend" {
  return target === "assistant" ? "backend" : "utilityBackend";
}

export function parseBackendTarget(value: string): BackendTarget | null {
  if (value === "assistant" || value === "utility") return value;
  return null;
}

export function setBackend(
  target: BackendTarget,
  backend: BackendName,
  scope: ConfigScope = "project"
) {
  return updateConfig(scope, { [backendField(target)]: backend } as const);
}
