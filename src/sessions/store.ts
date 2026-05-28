import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import type { Session } from "./types.js";
import type { RiteConfig } from "../config/types.js";

function sessionsDir(): string {
  return join(process.cwd(), ".rite", "sessions");
}

export function makeSessionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    now.getFullYear(),
    "-",
    pad(now.getMonth() + 1),
    "-",
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

export function sessionFilePath(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}

export function createSession(
  config: RiteConfig,
  type: "repl" | "loop" = "repl"
): Session {
  const now = new Date().toISOString();
  return {
    id: makeSessionId(),
    name: null,
    createdAt: now,
    updatedAt: now,
    workingDir: process.cwd(),
    backend: config.backend,
    type,
    turns: [],
    memoriesActive: [],
  };
}

export function saveSession(session: Session): void {
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    sessionFilePath(session.id),
    JSON.stringify(session, null, 2),
    "utf-8"
  );
}

export function loadSession(id: string): Session {
  const filePath = sessionFilePath(id);
  if (!existsSync(filePath)) {
    throw new Error(`Session not found: ${id}`);
  }
  return JSON.parse(readFileSync(filePath, "utf-8")) as Session;
}

export function listSessions(): Session[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const sessions: Session[] = [];
  for (const file of files) {
    try {
      sessions.push(JSON.parse(readFileSync(join(dir, file), "utf-8")) as Session);
    } catch {
      // skip malformed files
    }
  }
  return sessions.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function renameSession(id: string, name: string): void {
  const session = loadSession(id);
  session.name = name;
  session.updatedAt = new Date().toISOString();
  saveSession(session);
}

export function deleteSession(id: string): void {
  const filePath = sessionFilePath(id);
  if (!existsSync(filePath)) {
    throw new Error(`Session not found: ${id}`);
  }
  unlinkSync(filePath);
}

export function findSession(idOrName: string): Session | null {
  const all = listSessions();
  const exact = all.find((s) => s.id === idOrName);
  if (exact) return exact;
  const prefix = all.find((s) => s.id.startsWith(idOrName));
  if (prefix) return prefix;
  const byName = all.find(
    (s) => s.name != null && s.name.toLowerCase() === idOrName.toLowerCase()
  );
  return byName ?? null;
}
