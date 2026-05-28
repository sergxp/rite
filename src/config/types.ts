export type BackendName = "claude" | "codex" | "copilot";

export interface RiteConfig {
  backend: BackendName;
  utilityBackend: BackendName;
  historyLimit: number;
  tokenBudget: number;
  anthropicApiKey: string;
}

export const DEFAULT_CONFIG: RiteConfig = {
  backend: "claude",
  utilityBackend: "claude",
  historyLimit: 20,
  tokenBudget: 8000,
  anthropicApiKey: "",
};
