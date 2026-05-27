import React, { useState, useCallback, useEffect, useRef } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { ConversationHistory } from "./history.js";
import { buildEnrichedPrompt } from "./enricher.js";
import { loadMemories } from "../memory/reader.js";
import { semanticSearch } from "../memory/embeddings.js";
import { getBackend } from "../backends/index.js";
import { extractMemories } from "../extraction/extractor.js";
import { compressHistoryIfNeeded } from "../history/compressor.js";
import type { BackendName } from "../backends/index.js";
import type { MemoryFile } from "../memory/types.js";
import type { RiteConfig } from "../config/types.js";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ReplProps {
  backend: BackendName;
  historyLimit: number;
  config: RiteConfig;
}

function Repl({ backend, historyLimit, config }: ReplProps) {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamBuffer, setStreamBuffer] = useState("");
  const [alwaysMemories, setAlwaysMemories] = useState<MemoryFile[]>([]);
  const [semanticCandidates, setSemanticCandidates] = useState<MemoryFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showMemoryIndicator, setShowMemoryIndicator] = useState(false);
  const [lastMemoryCount, setLastMemoryCount] = useState(0);
  const [embeddingLoading, setEmbeddingLoading] = useState(false);

  const historyRef = useRef(new ConversationHistory(historyLimit));

  useEffect(() => {
    const loaded = loadMemories();
    setAlwaysMemories(loaded.always);
    setSemanticCandidates(loaded.semantic);
  }, []);

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      setInput("");

      if (trimmed === "/clear") {
        historyRef.current.clear();
        setMessages([{ role: "system", content: "History cleared." }]);
        return;
      }

      if (trimmed === "/memory") {
        const loaded = loadMemories();
        setAlwaysMemories(loaded.always);
        setSemanticCandidates(loaded.semantic);
        const lines = loaded.all.map(
          (m) =>
            `  [${m.tier}] ${m.frontmatter.name} (${m.frontmatter.inject}) — ${m.frontmatter.type}`
        );
        const content =
          lines.length > 0
            ? `Loaded memories:\n${lines.join("\n")}`
            : "No memories loaded.";
        setMessages((prev) => [...prev, { role: "system", content }]);
        return;
      }

      setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
      setStreaming(true);
      setStreamBuffer("");
      setError(null);

      let semanticHits: MemoryFile[] = [];
      if (semanticCandidates.length > 0) {
        setEmbeddingLoading(true);
        try {
          semanticHits = await semanticSearch(trimmed, semanticCandidates, 5);
        } catch {
          // graceful degradation
        }
        setEmbeddingLoading(false);
      }

      const enriched = buildEnrichedPrompt(
        trimmed,
        alwaysMemories,
        semanticHits,
        historyRef.current
      );

      let fullResponse = "";
      try {
        const backendFn = getBackend(backend);
        for await (const chunk of backendFn(enriched)) {
          fullResponse += chunk;
          setStreamBuffer(fullResponse);
        }

        historyRef.current.add("user", trimmed);
        historyRef.current.add("assistant", fullResponse);

        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: fullResponse },
        ]);

        await compressHistoryIfNeeded(historyRef.current, config);

        void extractMemories(trimmed, fullResponse, config, (count) => {
          setLastMemoryCount(count);
          setShowMemoryIndicator(true);
          setTimeout(() => setShowMemoryIndicator(false), 3000);
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setMessages((prev) => [
          ...prev,
          { role: "system", content: `Error: ${msg}` },
        ]);
      } finally {
        setStreaming(false);
        setStreamBuffer("");
      }
    },
    [backend, alwaysMemories, semanticCandidates, config]
  );

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
  });

  const visibleMessages = messages.slice(-40);

  return (
    <Box flexDirection="column" width="100%">
      {/* Status bar */}
      <Box borderStyle="single" paddingX={1}>
        <Text bold color="cyan">
          rite
        </Text>
        <Text color="gray"> | </Text>
        <Text color="green">{backend}</Text>
        <Text color="gray"> | </Text>
        <Text color="yellow">{alwaysMemories.length} memories</Text>
        {streaming && (
          <>
            <Text color="gray"> | </Text>
            <Text color="magenta">thinking...</Text>
          </>
        )}
        {embeddingLoading && (
          <Text color="gray"> | ◌ embedding</Text>
        )}
        {showMemoryIndicator && (
          <>
            <Text color="gray"> | </Text>
            <Text color="blue">◎ {lastMemoryCount} saved</Text>
          </>
        )}
      </Box>

      {/* Messages */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {visibleMessages.map((msg, i) => {
          if (msg.role === "user") {
            return (
              <Box key={i} marginTop={1}>
                <Text color="cyan" bold>
                  {">"}{" "}
                </Text>
                <Text>{msg.content}</Text>
              </Box>
            );
          }
          if (msg.role === "system") {
            return (
              <Box key={i} marginTop={1}>
                <Text color="gray" italic>
                  {msg.content}
                </Text>
              </Box>
            );
          }
          return (
            <Box key={i} marginTop={1} flexDirection="column">
              <Text color="green" dimColor>
                assistant:
              </Text>
              <Text>{msg.content}</Text>
            </Box>
          );
        })}

        {/* Live stream buffer */}
        {streaming && streamBuffer && (
          <Box marginTop={1} flexDirection="column">
            <Text color="green" dimColor>
              assistant:
            </Text>
            <Text>{streamBuffer}</Text>
          </Box>
        )}

        {streaming && !streamBuffer && (
          <Box marginTop={1}>
            <Text color="magenta" dimColor>
              Thinking...
            </Text>
          </Box>
        )}
      </Box>

      {/* Divider */}
      <Box borderStyle="single" paddingX={1}>
        <Text color="gray" dimColor>
          /clear · /memory · ctrl+c to exit
        </Text>
      </Box>

      {/* Input */}
      <Box paddingX={1}>
        <Text color="cyan" bold>
          {">"}{" "}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder="Type a message..."
        />
      </Box>
    </Box>
  );
}

export async function startRepl(
  backend: BackendName,
  historyLimit: number,
  config: RiteConfig
): Promise<void> {
  const { waitUntilExit } = render(
    <Repl backend={backend} historyLimit={historyLimit} config={config} />
  );
  await waitUntilExit();
}
