export interface RiteConfig {
  backend: "claude" | "codex";
  historyLimit: number;
  tokenBudget: number;
  anthropicApiKey: string;
}

export const DEFAULT_CONFIG: RiteConfig = {
  backend: "claude",
  historyLimit: 20,
  tokenBudget: 8000,
  anthropicApiKey: "",
};
