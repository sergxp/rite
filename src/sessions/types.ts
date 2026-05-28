import type { BackendName } from "../config/types.js";

export interface SessionMemoryRef {
  name: string;
  tier: "global" | "workspace" | "project";
  inject: "always" | "semantic" | "never";
}

export interface Session {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  workingDir: string;
  backend: BackendName;
  type: "repl" | "loop";
  turns: Array<{ role: "user" | "assistant"; content: string }>;
  memoriesActive: SessionMemoryRef[];
  loopName?: string;
  loopContext?: string;
  stepOutputs?: Record<string, string>;
}
