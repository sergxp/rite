import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import type { MemoryFile } from "./types.js";

type EmbeddingPipeline = (
  text: string,
  opts: { pooling: string; normalize: boolean }
) => Promise<{ data: Float32Array }>;

let pipelinePromise: Promise<EmbeddingPipeline> | null = null;

export async function getEmbeddingPipeline(): Promise<EmbeddingPipeline> {
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    const { pipeline, env } = await import("@xenova/transformers");
    // Model cache stays in ~/.rite/models (unchanged).
    const { join: j } = await import("path");
    const { default: os } = await import("os");
    env.cacheDir = j(os.homedir(), ".rite", "models");
    const pipe = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    return pipe as unknown as EmbeddingPipeline;
  })();

  return pipelinePromise;
}

export async function embedText(text: string): Promise<number[]> {
  const pipe = await getEmbeddingPipeline();
  const output = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

interface IndexCache {
  vector: number[];
  updated: string;
}

/**
 * Returns the .index/ directory co-located with the memory file's parent directory.
 * e.g. ~/.rite/memory/C--Repos-rite/foo.md → ~/.rite/memory/C--Repos-rite/.index/
 */
function getIndexDir(filePath: string): string {
  return join(dirname(filePath), ".index");
}

function getCachePath(filePath: string): string {
  const slug = filePath
    .split(/[\\/]/)
    .pop()!
    .replace(/\.md$/, "");
  return join(getIndexDir(filePath), `${slug}.json`);
}

export async function getOrCreateEmbedding(
  memoryFile: MemoryFile
): Promise<number[] | null> {
  try {
    const cachePath = getCachePath(memoryFile.filePath);

    if (existsSync(cachePath)) {
      const cached = JSON.parse(
        readFileSync(cachePath, "utf-8")
      ) as IndexCache;
      if (cached.updated === memoryFile.frontmatter.updated) {
        return cached.vector;
      }
    }

    const vector = await embedText(memoryFile.content);

    const indexDir = getIndexDir(memoryFile.filePath);
    if (!existsSync(indexDir)) {
      mkdirSync(indexDir, { recursive: true });
    }

    const cache: IndexCache = { vector, updated: memoryFile.frontmatter.updated };
    writeFileSync(cachePath, JSON.stringify(cache), "utf-8");

    return vector;
  } catch {
    return null;
  }
}

export async function embedAndCacheMemory(
  filePath: string,
  content: string,
  updated: string
): Promise<void> {
  try {
    const indexDir = getIndexDir(filePath);
    const cachePath = getCachePath(filePath);

    const vector = await embedText(content);

    if (!existsSync(indexDir)) {
      mkdirSync(indexDir, { recursive: true });
    }

    const cache: IndexCache = { vector, updated };
    writeFileSync(cachePath, JSON.stringify(cache), "utf-8");
  } catch {
    // swallow — embedding is best-effort
  }
}

export async function semanticSearch(
  query: string,
  candidates: MemoryFile[],
  topN = 5
): Promise<Array<{ file: MemoryFile; score: number }>> {
  try {
    const queryVector = await embedText(query);

    const scored: Array<{ file: MemoryFile; score: number }> = [];

    for (const candidate of candidates) {
      try {
        const vector = await getOrCreateEmbedding(candidate);
        if (!vector) continue;
        const score = cosineSimilarity(queryVector, vector);
        scored.push({ file: candidate, score });
      } catch {
        // skip this candidate
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
  } catch {
    // pipeline failed — degrade gracefully
    return candidates.slice(0, topN).map((file) => ({ file, score: 0 }));
  }
}
