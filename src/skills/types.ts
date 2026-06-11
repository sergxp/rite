export interface Skill {
  name: string;
  description: string;
  content: string;
  filePath: string;
  scope: "global" | "project";
}
