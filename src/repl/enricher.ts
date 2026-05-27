import type { MemoryFile } from "../memory/types.js";
import type { ConversationHistory } from "./history.js";

export function buildEnrichedPrompt(
  userMessage: string,
  alwaysMemories: MemoryFile[],
  semanticMemories: MemoryFile[],
  history: ConversationHistory
): string {
  const parts: string[] = [];

  const alwaysPaths = new Set(alwaysMemories.map((m) => m.filePath));
  const deduplicatedSemantic = semanticMemories.filter(
    (m) => !alwaysPaths.has(m.filePath)
  );

  const hasAlways = alwaysMemories.length > 0;
  const hasSemantic = deduplicatedSemantic.length > 0;

  if (hasAlways || hasSemantic) {
    const sections: string[] = [];

    if (hasAlways) {
      const block = alwaysMemories.map((m) => m.content).join("\n\n---\n\n");
      sections.push(`[always]\n${block}`);
    }

    if (hasSemantic) {
      const block = deduplicatedSemantic
        .map((m) => m.content)
        .join("\n\n---\n\n");
      sections.push(`[semantic]\n${block}`);
    }

    parts.push(`<memory>\n${sections.join("\n\n")}\n</memory>`);
  }

  const historyStr = history.getFormatted();
  if (historyStr.trim()) {
    parts.push(`<history>\n${historyStr}\n</history>`);
  }

  parts.push(`<message>\n${userMessage}\n</message>`);

  return parts.join("\n\n");
}
