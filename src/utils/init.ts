import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import os from "os";
import peerProgramming from "../loops/defaults/peer-programming.json" with { type: "json" };

const GITIGNORE_CONTENT = `memory/*.md
memory/.index/
!memory/team/
sessions/
audit.jsonl
config.json
logs/
`;

const DEFAULT_LOOPS: Array<{ name: string; filename: string; content: unknown }> = [
  { name: "peer-programming", filename: "peer-programming.json", content: peerProgramming },
];

// Seeds bundled default loops into ~/.rite/loops/ if they don't already exist there.
// Never overwrites — user customizations are preserved.
export function ensureDefaultLoops(): void {
  const globalLoopsDir = join(os.homedir(), ".rite", "loops");
  mkdirSync(globalLoopsDir, { recursive: true });

  for (const loop of DEFAULT_LOOPS) {
    const dest = join(globalLoopsDir, loop.filename);
    if (!existsSync(dest)) {
      writeFileSync(dest, JSON.stringify(loop.content, null, 2), "utf-8");
    }
  }
}

export function ensureRiteDir(): void {
  const riteDir = join(process.cwd(), ".rite");
  const alreadyExists = existsSync(riteDir);

  mkdirSync(join(riteDir, "memory"), { recursive: true });
  mkdirSync(join(riteDir, "loops"), { recursive: true });
  mkdirSync(join(riteDir, "sessions"), { recursive: true });

  if (!alreadyExists) {
    writeFileSync(join(riteDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
  }
}
