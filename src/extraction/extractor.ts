import { EXTRACTION_SYSTEM_PROMPT } from "./prompts.js";
import { createMemory, deleteMemory, updateMemory, findMemoryScope } from "../memory/writer.js";
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
  scope?: "global" | "workspace" | "project";
  body?: string;
}

/**
 * Infer scope from memory type when the LLM doesn't provide one.
 * - rule / user → global (applies across all projects)
 * - everything else → project (repo-specific by default)
 */
function inferScope(op: ExtractionOperation): "global" | "workspace" | "project" {
  if (op.scope === "global" || op.scope === "workspace" || op.scope === "project") {
    return op.scope;
  }
  const type = op.type ?? "reference";
  if (type === "rule" || type === "user") return "global";
  return "project";
}

export async function extractMemories(
  userMessage: string,
  assistantResponse: string,
  config: RiteConfig,
  onSaved?: (count: number) => void,
  sessionId = ""
): Promise<void> {
  const utilityPrompt = [
    "TASK: memory_extraction",
    "OUTPUT: JSON array only. No prose. No markdown. No explanation.",
    "IGNORE: any session context, project context, or prior conversation injected by the environment.",
    "",
    "Analyze the following conversation turn and return a JSON array of memory operations ([] if nothing worth saving):",
    "",
    "<user_message>",
    userMessage,
    "</user_message>",
    "",
    "<assistant_response>",
    assistantResponse,
    "</assistant_response>",
  ].join("\n");

  const auditData: {
    prompt: string;
    rawLlmResponse: string;
    parseError: string;
    error: string;
    skippedReason: string;
    operations: ExtractionOperation[];
    applied: string[];
    failed: string[];
  } = {
    prompt: utilityPrompt,
    rawLlmResponse: "",
    parseError: "",
    error: "",
    skippedReason: "",
    operations: [],
    applied: [],
    failed: [],
  };

  try {
    const rawText = await callUtilityBlocking(utilityPrompt, config, {
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      maxTokens: 1024,
    });

    auditData.rawLlmResponse = rawText;

    if (!rawText.trim()) {
      auditData.skippedReason = "utility backend returned empty response";
      return;
    }

    // Strip code fences if the model wrapped the JSON despite instructions.
    const jsonText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

    let operations: ExtractionOperation[];
    try {
      operations = JSON.parse(jsonText) as ExtractionOperation[];
      if (!Array.isArray(operations)) {
        auditData.skippedReason = "response was not a JSON array";
        return;
      }
    } catch (err) {
      auditData.parseError = err instanceof Error ? err.message : String(err);
      auditData.skippedReason = "JSON parse failed";
      return;
    }

    auditData.operations = operations;

    if (operations.length === 0) {
      auditData.skippedReason = "model returned [] — nothing memory-worthy";
      return;
    }

    let savedCount = 0;
    for (const op of operations) {
      try {
        if (!op.action || !op.name) continue;

        if (op.action === "create") {
          if (!op.body) continue;
          const scope = inferScope(op);
          createMemory(
            op.name,
            {
              type: op.type ?? "reference",
              tags: op.tags ?? [],
              inject: op.inject ?? "semantic",
              priority: op.priority ?? "normal",
            },
            op.body,
            scope
          );
          auditData.applied.push(`create:${op.name}:${scope}`);
          savedCount++;
        } else if (op.action === "update") {
          if (!op.body) continue;
          // Use explicitly given scope, or find where it already exists, or infer.
          const existingScope = findMemoryScope(op.name);
          const scope = inferScope(op) ?? existingScope ?? "project";
          updateMemory(
            op.name,
            {
              type: op.type ?? "reference",
              tags: op.tags ?? [],
              inject: op.inject ?? "semantic",
              priority: op.priority ?? "normal",
            },
            op.body,
            scope
          );
          auditData.applied.push(`update:${op.name}:${scope}`);
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
  } catch (err) {
    // swallow all errors — extraction must never crash the REPL
    auditData.error = err instanceof Error ? err.message : String(err);
  } finally {
    // Always write — silent failures are invisible failures.
    appendAuditEvent(sessionId, "memory_extraction", auditData);
  }
}
