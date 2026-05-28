import { existsSync } from "fs";
import { join } from "path";
import os from "os";
import { EXTRACTION_SYSTEM_PROMPT } from "./prompts.js";
import { createMemory, deleteMemory, updateMemory } from "../memory/writer.js";
import { appendAuditEvent } from "../audit/writer.js";
import { callUtilityBlocking } from "../backends/utility.js";
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
  onSaved?: (count: number) => void,
  sessionId = ""
): Promise<void> {
  const auditData: {
    userMessage: string;
    assistantResponse: string;
    rawLlmResponse: string;
    operations: ExtractionOperation[];
    applied: string[];
    failed: string[];
  } = {
    userMessage,
    assistantResponse,
    rawLlmResponse: "",
    operations: [],
    applied: [],
    failed: [],
  };

  try {
    const rawText = await callUtilityBlocking(
      `User: ${userMessage}\n\nAssistant: ${assistantResponse}`,
      config,
      {
        systemPrompt: EXTRACTION_SYSTEM_PROMPT,
        maxTokens: 1024,
      }
    );

    auditData.rawLlmResponse = rawText;
    if (!rawText.trim()) return;

    let operations: ExtractionOperation[];
    try {
      operations = JSON.parse(rawText) as ExtractionOperation[];
      if (!Array.isArray(operations)) return;
    } catch {
      return;
    }

    auditData.operations = operations;
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
          auditData.applied.push(`create:${op.name}`);
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
          auditData.applied.push(`update:${op.name}`);
          savedCount++;
        } else if (op.action === "delete") {
          deleteMemory(op.name);
          auditData.applied.push(`delete:${op.name}`);
          savedCount++;
        }
      } catch (err) {
        auditData.failed.push(
          `${op.action}:${op.name} — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (savedCount > 0 && onSaved) {
      onSaved(savedCount);
    }
  } catch {
    // swallow all errors — extraction must never crash the REPL
  } finally {
    if (auditData.rawLlmResponse || auditData.operations.length > 0) {
      appendAuditEvent(sessionId, "memory_extraction", auditData);
    }
  }
}
