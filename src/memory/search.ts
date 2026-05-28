import { loadMemories } from "./reader.js";
import { semanticSearch } from "./embeddings.js";
import type { MemoryFile } from "./types.js";

export async function searchMemories(query: string): Promise<MemoryFile[]> {
  const loaded = loadMemories();
  const q = query.toLowerCase();

  const keywordResults = loaded.all.filter((m) => {
    if (m.frontmatter.name.toLowerCase().includes(q)) return true;
    if (m.frontmatter.tags.some((t) => t.toLowerCase().includes(q))) return true;
    if (m.content.toLowerCase().includes(q)) return true;
    return false;
  });

  const semanticResults = await semanticSearch(query, loaded.all, 10);

  const seen = new Set<string>(keywordResults.map((m) => m.filePath));
  const merged = [...keywordResults];

  for (const { file } of semanticResults) {
    if (!seen.has(file.filePath)) {
      merged.push(file);
      seen.add(file.filePath);
    }
  }

  return merged;
}
