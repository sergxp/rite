import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const GITIGNORE_CONTENT = `memory/*.md
memory/.index/
!memory/team/
config.json
`;

export function ensureRiteDir(): void {
  const riteDir = join(process.cwd(), ".rite");
  const alreadyExists = existsSync(riteDir);

  mkdirSync(join(riteDir, "memory"), { recursive: true });
  mkdirSync(join(riteDir, "loops"), { recursive: true });

  if (!alreadyExists) {
    writeFileSync(join(riteDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
  }
}
