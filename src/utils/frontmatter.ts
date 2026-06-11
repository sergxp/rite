import matter from "gray-matter";
import { readFileSync, existsSync } from "fs";
import yaml from "yaml";

export interface ParsedFile {
  data: Record<string, unknown>;
  content: string;
}

export function parseFrontmatter(filePath: string): ParsedFile | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = matter(raw);
    return { data: parsed.data as Record<string, unknown>, content: parsed.content };
  } catch {
    return null;
  }
}

export function writeFrontmatter(
  data: object,
  body: string
): string {
  const frontmatterStr = yaml.stringify(data).trim();
  return `---\n${frontmatterStr}\n---\n\n${body}\n`;
}
