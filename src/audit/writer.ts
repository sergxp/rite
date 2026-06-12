import { appendFile, mkdirSync, existsSync } from "fs";
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

let dirEnsured = false;
function ensureDir() {
  if (dirEnsured) return;
  try {
    const dir = join(process.cwd(), ".rite");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    dirEnsured = true;
  } catch {
    /* ignore */
  }
}

// Async, fire-and-forget — never block the caller's event loop turn on disk.
// Audit entries are best-effort: a hard crash before flush may drop the in-flight
// line, which is acceptable since the same prompt is also captured in the
// session JSONL log.
export function appendAuditEvent(
  sessionId: string,
  event: string,
  data: unknown
): void {
  ensureDir();
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    sessionId,
    event,
    data,
  };
  let line: string;
  try {
    line = JSON.stringify(entry) + "\n";
  } catch {
    return;
  }
  appendFile(auditFilePath(), line, "utf-8", () => {
    /* audit must never crash the caller */
  });
}
