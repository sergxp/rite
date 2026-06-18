import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import type { MemoryFile } from "./types.js";
import { log } from "../utils/logger.js";

const elog = log.child("embeddings");

type EmbeddingPipeline = (
  text: string,
  opts: { pooling: string; normalize: boolean }
) => Promise<{ data: Float32Array }>;

let pipelinePromise: Promise<EmbeddingPipeline> | null = null;
// Sticky: once the pipeline fails to load (missing onnxruntime native module,
// no network for model download, etc.) we permanently disable semantic search
// for this process. Subsequent calls return immediately so the user never
// pays the load-attempt cost again on Enter press.
let pipelineDisabled = false;

export function isEmbeddingDisabled(): boolean {
  return pipelineDisabled;
}

export async function getEmbeddingPipeline(): Promise<EmbeddingPipeline> {
  if (pipelineDisabled) throw new Error("embedding pipeline disabled");
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    const started = Date.now();
    elog.info("pipeline.load.start", { model: "Xenova/all-MiniLM-L6-v2" });
    try {
      const { pipeline, env } = await import("@xenova/transformers");
      const { join: j } = await import("path");
      const { default: os } = await import("os");
      env.cacheDir = j(os.homedir(), ".rite", "models");
      const pipe = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
      elog.info("pipeline.load.done", { durationMs: Date.now() - started, cacheDir: env.cacheDir });
      return pipe as unknown as EmbeddingPipeline;
    } catch (err) {
      pipelineDisabled = true;
      elog.error("pipeline.load.failed", { durationMs: Date.now() - started, err });
      throw err;
    }
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
        elog.trace("cache.hit", { name: memoryFile.frontmatter.name });
        return cached.vector;
      }
      elog.debug("cache.stale", { name: memoryFile.frontmatter.name });
    }

    const t0 = Date.now();
    const vector = await embedText(memoryFile.content);

    const indexDir = getIndexDir(memoryFile.filePath);
    if (!existsSync(indexDir)) {
      mkdirSync(indexDir, { recursive: true });
    }

    const cache: IndexCache = { vector, updated: memoryFile.frontmatter.updated };
    writeFileSync(cachePath, JSON.stringify(cache), "utf-8");
    elog.debug("cache.write", { name: memoryFile.frontmatter.name, durationMs: Date.now() - t0, dim: vector.length });

    return vector;
  } catch (err) {
    elog.warn("getOrCreate.failed", { name: memoryFile.frontmatter.name, err });
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
    elog.debug("embedAndCache.done", { filePath, dim: vector.length });
  } catch (err) {
    elog.warn("embedAndCache.failed", { filePath, err });
  }
}

export async function semanticSearch(
  query: string,
  candidates: MemoryFile[],
  topN = 5,
  precomputedQueryVector?: number[],
): Promise<Array<{ file: MemoryFile; score: number }>> {
  const t0 = Date.now();
  // Skip the work entirely if a prior call already established the pipeline
  // is broken on this machine. Saves 3–10s on the submit hot path.
  if (isEmbeddingDisabled()) {
    elog.debug("search.skipped.disabled", { candidates: candidates.length });
    return [];
  }
  elog.debug("search.start", { queryLen: query.length, candidates: candidates.length, topN, precomputed: !!precomputedQueryVector });
  // Soft budget: if the search is still working after this many ms, abandon
  // it and return what we have. The model-loading + download path on a fresh
  // machine can take seconds, and we'd rather submit without semantic hits
  // than block the user's Enter press.
  const SEARCH_BUDGET_MS = 1500;
  let budgetExceeded = false;
  const budgetTimer = setTimeout(() => {
    budgetExceeded = true;
  }, SEARCH_BUDGET_MS);

  try {
    const queryVector = precomputedQueryVector ?? await embedText(query);

    const scored: Array<{ file: MemoryFile; score: number }> = [];
    let skipped = 0;

    for (const candidate of candidates) {
      if (budgetExceeded) {
        elog.warn("search.budget.exceeded", { durationMs: Date.now() - t0, processed: scored.length, total: candidates.length });
        break;
      }
      try {
        const vector = await getOrCreateEmbedding(candidate);
        if (!vector) { skipped++; continue; }
        const score = cosineSimilarity(queryVector, vector);
        scored.push({ file: candidate, score });
      } catch (err) {
        skipped++;
        elog.warn("search.candidate.failed", { name: candidate.frontmatter.name, err });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, topN);
    elog.info("search.done", {
      durationMs: Date.now() - t0,
      scored: scored.length,
      skipped,
      returned: top.length,
      top: top.map((h) => ({ name: h.file.frontmatter.name, score: Number(h.score.toFixed(4)) })),
    });
    return top;
  } catch (err) {
    elog.error("search.failed", { durationMs: Date.now() - t0, err });
    return [];
  } finally {
    clearTimeout(budgetTimer);
  }
}
