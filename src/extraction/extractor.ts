import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "fs";
import { join } from "path";
import os from "os";
import { EXTRACTION_SYSTEM_PROMPT } from "./prompts.js";
import { createMemory, deleteMemory, updateMemory } from "../memory/writer.js";
import type { MemoryType, InjectMode, Priority } from "../memory/types.js";
import type { RiteConfig } from "../config/types.js";

export interface ExtractionOperation {
  action: "create" | "update" | "delete";
  name: string;
  type?: MemoryType;
  tags?: string[];
  inject?: InjectMode;
  priority?: Priority;
  body?: string;
}

function memoryFileExists(name: string, scope: "global" | "project"): boolean {
  const dir =
    scope === "global"
      ? join(os.homedir(), ".rite", "memory")
      : join(process.cwd(), ".rite", "memory");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return existsSync(join(dir, `${slug}.md`));
}

export async function extractMemories(
  userMessage: string,
  assistantResponse: string,
  config: RiteConfig,
  onSaved?: (count: number) => void
): Promise<void> {
  try {
    const apiKey =
      process.env.ANTHROPIC_API_KEY ?? config.anthropicApiKey ?? "";
    if (!apiKey) return;

    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `User: ${userMessage}\n\nAssistant: ${assistantResponse}`,
        },
      ],
    });

    const rawText =
      response.content[0]?.type === "text" ? response.content[0].text : "";
    if (!rawText.trim()) return;

    let operations: ExtractionOperation[];
    try {
      operations = JSON.parse(rawText) as ExtractionOperation[];
      if (!Array.isArray(operations)) return;
    } catch {
      return;
    }

    let savedCount = 0;

    for (const op of operations) {
      try {
        if (!op.action || !op.name) continue;

        if (op.action === "create") {
          if (!op.body) continue;
          createMemory(
            op.name,
            {
              type: op.type ?? "reference",
              tags: op.tags ?? [],
              inject: op.inject ?? "semantic",
              priority: op.priority ?? "normal",
            },
            op.body,
            "project"
          );
          savedCount++;
        } else if (op.action === "update") {
          if (!op.body) continue;
          updateMemory(
            op.name,
            {
              type: op.type ?? "reference",
              tags: op.tags ?? [],
              inject: op.inject ?? "semantic",
              priority: op.priority ?? "normal",
            },
            op.body,
            memoryFileExists(op.name, "global") ? "global" : "project"
          );
          savedCount++;
        } else if (op.action === "delete") {
          deleteMemory(op.name);
          savedCount++;
        }
      } catch {
        // swallow per-operation errors silently
      }
    }

    if (savedCount > 0 && onSaved) {
      onSaved(savedCount);
    }
  } catch {
    // swallow all errors — extraction must never crash the REPL
  }
}
