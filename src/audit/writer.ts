import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

interface AuditEntry {
  ts: string;
  sessionId: string;
  event: string;
  data: unknown;
}

function auditFilePath(): string {
  return join(process.cwd(), ".rite", "audit.jsonl");
}

export function appendAuditEvent(
  sessionId: string,
  event: string,
  data: unknown
): void {
  try {
    mkdirSync(join(process.cwd(), ".rite"), { recursive: true });
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      sessionId,
      event,
      data,
    };
    appendFileSync(auditFilePath(), JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // audit must never crash the caller
  }
}
