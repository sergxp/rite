import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import os from "os";
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
    env.cacheDir = join(os.homedir(), ".rite", "models");
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

function getIndexDir(): string {
  return join(process.cwd(), ".rite", "memory", ".index");
}

function getCachePath(filePath: string): string {
  const slug = filePath
    .split(/[\\/]/)
    .pop()!
    .replace(/\.md$/, "");
  return join(getIndexDir(), `${slug}.json`);
}

export async function getOrCreateEmbedding(
  memoryFile: MemoryFile
): Promise<number[] | null> {
  try {
    const indexDir = getIndexDir();
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
    const indexDir = getIndexDir();
    const slug = filePath
      .split(/[\\/]/)
      .pop()!
      .replace(/\.md$/, "");
    const cachePath = join(indexDir, `${slug}.json`);

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
): Promise<MemoryFile[]> {
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
    return scored.slice(0, topN).map((s) => s.file);
  } catch {
    // pipeline failed — degrade gracefully
    return candidates.slice(0, topN);
  }
}
