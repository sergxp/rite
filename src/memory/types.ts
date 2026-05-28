export type MemoryType = "rule" | "project" | "user" | "feedback" | "reference";
export type InjectMode = "always" | "semantic" | "never";
export type Priority = "high" | "normal" | "low";

export interface MemoryFrontmatter {
  name: string;
  type: MemoryType;
  tags: string[];
  inject: InjectMode;
  priority: Priority;
  created: string;
  updated: string;
}

export interface MemoryFile {
  frontmatter: MemoryFrontmatter;
  content: string;
  filePath: string;
  tier: "global" | "workspace" | "project";
  /** The slug (subfolder name) this memory was loaded from, e.g. "C--Repositories-rite" */
  slug: string;
}
