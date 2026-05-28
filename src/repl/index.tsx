import React, { useState, useRef, useCallback, useEffect } from "react";
import { render, Box, Text, Static, useApp, useInput, useStdout } from "ink";
import { ConversationHistory } from "./history.js";
import { buildEnrichedPrompt } from "./enricher.js";
import { loadMemories } from "../memory/reader.js";
import { semanticSearch } from "../memory/embeddings.js";
import { getBackend } from "../backends/index.js";
import { extractMemories } from "../extraction/extractor.js";
import { compressHistoryIfNeeded } from "../history/compressor.js";
import {
  createSession,
  saveSession,
  loadSession,
  listSessions,
} from "../sessions/store.js";
import { SessionPicker } from "../sessions/picker.js";
import { appendAuditEvent } from "../audit/writer.js";
import { Composer } from "./composer.js";
import { MessageBubble, type Message } from "./message.js";
import {
  renderAssistantAnsi,
  renderUserAnsi,
  renderSystemAnsi,
} from "./ansi-render.js";
import {
  setBackend,
  parseBackendTarget,
  type BackendTarget,
} from "../settings/backends.js";
import type { BackendName, RiteConfig } from "../config/types.js";
import type { MemoryFile } from "../memory/types.js";
import type { Session } from "../sessions/types.js";

//  helpers 

let _seq = 0;
function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${_seq++}`;
}

const SPINNER = ["|", "/", "-", "\\", "|", "/", "-", "\\", "|", "/"];

function isValidBackend(s: string): s is BackendName {
  return s === "claude" || s === "codex" || s === "copilot";
}

function parseBackendSwitchArg(
  raw: string
): { target: BackendTarget; backend: BackendName } | null {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1 && isValidBackend(parts[0])) {
    return { target: "assistant", backend: parts[0] };
  }
  if (parts.length === 2) {
    const target = parseBackendTarget(parts[0]);
    if (target && isValidBackend(parts[1])) {
      return { target, backend: parts[1] };
    }
  }
  return null;
}

//  component 

interface ReplProps {
  backend: BackendName;
  historyLimit: number;
  config: RiteConfig;
  resumeSessionId?: string;
}

function Repl({ backend, historyLimit, config, resumeSessionId }: ReplProps) {
  const { exit } = useApp();
  const { write } = useStdout();

  // Completed messages go into <Static>  only grows, never mutates old items.
  // staticKey is bumped on /clear to remount Static from scratch (Gemini CLI pattern).
  const [staticKey, setStaticKey] = useState(0);
  const [completed, setCompleted] = useState<Message[]>([]);

  // Live area
  const [streamContent, setStreamContent] = useState("");
  const [thinkingChars, setThinkingChars] = useState(0);
  const [thinkingPreview, setThinkingPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [embeddingBusy, setEmbeddingBusy] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  // Tool call tracking for live display
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [toolsSeen, setToolsSeen] = useState<string[]>([]);

  // Input
  const [input, setInput] = useState("");
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  // App state
  const [assistantBackend, setAssistantBackend] =
    useState<BackendName>(backend);
  const [runtimeConfig, setRuntimeConfig] = useState<RiteConfig>(config);
  const [alwaysMemories, setAlwaysMemories] = useState<MemoryFile[]>([]);
  const [semanticCandidates, setSemanticCandidates] = useState<MemoryFile[]>(
    []
  );
  const [memoryIndicator, setMemoryIndicator] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerSessions, setPickerSessions] = useState<Session[]>([]);

  // Refs (mutated during streaming, not tracked by React)
  const histRef = useRef(new ConversationHistory(historyLimit));
  const sessionRef = useRef<Session | null>(null);
  const liveRef = useRef("");
  const thinkingRef = useRef({ chars: 0, text: "" });
  const abortControllerRef = useRef<AbortController | null>(null);

  //  spinner 

  useEffect(() => {
    if (!busy && !embeddingBusy) {
      setSpinnerFrame(0);
      return;
    }
    const t = setInterval(
      () => setSpinnerFrame((f) => (f + 1) % SPINNER.length),
      80
    );
    return () => clearInterval(t);
  }, [busy, embeddingBusy]);

  //  streaming poll

  useEffect(() => {
    if (!busy) {
      liveRef.current = "";
      thinkingRef.current = { chars: 0, text: "" };
      setStreamContent("");
      setThinkingChars(0);
      setThinkingPreview("");
      return;
    }
    const t = setInterval(() => {
      setStreamContent(liveRef.current);
      setThinkingChars(thinkingRef.current.chars);
      setThinkingPreview(thinkingRef.current.text);
    }, 60);
    return () => clearInterval(t);
  }, [busy]);

  //  init 

  useEffect(() => {
    const loaded = loadMemories();
    setAlwaysMemories(loaded.always);
    setSemanticCandidates(loaded.semantic);

    if (resumeSessionId) {
      try {
        const resumed = loadSession(resumeSessionId);
        sessionRef.current = resumed;
        histRef.current.clear();
        for (const t of resumed.turns) histRef.current.add(t.role, t.content);
        setAssistantBackend(resumed.backend);
        setRuntimeConfig((c) => ({ ...c, backend: resumed.backend }));
        // Write history directly to stdout (avoids Static clipping for tall histories)
        write(renderSystemAnsi(`Resumed: ${resumed.name ?? resumed.id}`));
        for (const t of resumed.turns) {
          if (t.role === "user") write(renderUserAnsi(t.content));
          else if (t.role === "assistant") write(renderAssistantAnsi(t.content));
        }
        setCompleted([
          {
            id: makeId("sys"),
            role: "system",
            content: `Resumed: ${resumed.name ?? resumed.id}`,
          },
        ]);
      } catch {
        const s = createSession(config, "repl");
        sessionRef.current = s;
        saveSession(s);
        setCompleted([
          {
            id: makeId("sys"),
            role: "system",
            content: `Session not found. Starting fresh.`,
          },
        ]);
      }
    }
    // No else branch — session is created lazily on first message submit.
  }, [config, resumeSessionId, write]);

  //  helpers 

  const addCompleted = useCallback((msg: Message) => {
    setCompleted((prev) => [...prev, msg]);
  }, []);

  const refreshMemories = useCallback(() => {
    const loaded = loadMemories();
    setAlwaysMemories(loaded.always);
    setSemanticCandidates(loaded.semantic);
    return loaded;
  }, []);

  const persistBackend = useCallback(
    (target: BackendTarget, next: BackendName) => {
      const nextConfig = setBackend(target, next);
      setRuntimeConfig(nextConfig);
      if (target === "assistant") {
        setAssistantBackend(next);
        const s = sessionRef.current;
        if (s) {
          s.backend = next;
          s.updatedAt = new Date().toISOString();
          saveSession(s);
        }
      }
    },
    []
  );

  //  keyboard: history nav + ctrl+c 

  useInput((typed, key) => {
    // ctrl+c always exits
    if (key.ctrl && typed === "c") {
      exit();
      return;
    }

    // Escape cancels in-progress request
    if (key.escape && busy) {
      abortControllerRef.current?.abort();
      return;
    }

    if (busy || showPicker) return;

    if (key.upArrow) {
      if (inputHistory.length === 0) return;
      if (historyIdx === null) {
        setDraft(input);
        const idx = inputHistory.length - 1;
        setHistoryIdx(idx);
        setInput(inputHistory[idx] ?? "");
      } else {
        const idx = Math.max(0, historyIdx - 1);
        setHistoryIdx(idx);
        setInput(inputHistory[idx] ?? "");
      }
      return;
    }

    if (key.downArrow) {
      if (historyIdx === null) return;
      const idx = historyIdx + 1;
      if (idx >= inputHistory.length) {
        setHistoryIdx(null);
        setInput(draft);
      } else {
        setHistoryIdx(idx);
        setInput(inputHistory[idx] ?? "");
      }
      return;
    }
  });

  //  submit handler 

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      setInput("");
      setHistoryIdx(null);
      setDraft("");
      if (!trimmed) return;

      setInputHistory((prev) => [...prev, trimmed]);

      //  slash commands 

      if (trimmed === "/exit" || trimmed === "/quit") {
        exit();
        return;
      }

      if (trimmed === "/help") {
        addCompleted({
          id: makeId("sys"),
          role: "system",
          content: [
            "Commands:",
            "  /clear            clear AI context",
            "  /memory           show loaded memories",
            "  /backend          show current backends",
            "  /backend <name>   set assistant backend (claude | codex | copilot)",
            "  /backend assistant|utility <name>",
            "  /resume           switch session",
            "  /compact          compress conversation history",
            "  /exit             quit",
          ].join("\n"),
        });
        return;
      }

      if (trimmed === "/clear") {
        histRef.current.clear();
        const s = sessionRef.current;
        if (s) {
          s.turns = [];
          s.updatedAt = new Date().toISOString();
          saveSession(s);
        }
        // Remount <Static> from scratch  Gemini CLI pattern for visual clear
        setStaticKey((k) => k + 1);
        setCompleted([
          { id: makeId("sys"), role: "system", content: "Context cleared." },
        ]);
        return;
      }

      if (trimmed === "/memory") {
        const loaded = refreshMemories();
        const lines = loaded.all.map(
          (m) =>
            `  [${m.tier}] ${m.frontmatter.name} (${m.frontmatter.inject}) - ${m.frontmatter.type}`
        );
        addCompleted({
          id: makeId("sys"),
          role: "system",
          content:
            lines.length > 0
              ? `Memories:\n${lines.join("\n")}`
              : "No memories loaded.",
        });
        return;
      }

      if (trimmed === "/resume") {
        setPickerSessions(listSessions());
        setShowPicker(true);
        return;
      }

      if (trimmed === "/compact") {
        await compressHistoryIfNeeded(histRef.current, runtimeConfig);
        addCompleted({
          id: makeId("sys"),
          role: "system",
          content: "History compaction complete.",
        });
        return;
      }

      if (trimmed.startsWith("/backend")) {
        const rest = trimmed.slice("/backend".length).trim();
        if (!rest) {
          addCompleted({
            id: makeId("sys"),
            role: "system",
            content: `assistant=${runtimeConfig.backend}\nutility=${runtimeConfig.utilityBackend}`,
          });
          return;
        }
        const parsed = parseBackendSwitchArg(rest);
        if (!parsed) {
          addCompleted({
            id: makeId("sys"),
            role: "system",
            content:
              "Usage: /backend claude|codex|copilot\n" +
              "       /backend assistant|utility claude|codex|copilot",
          });
          return;
        }
        persistBackend(parsed.target, parsed.backend);
        addCompleted({
          id: makeId("sys"),
          role: "system",
          content: `Set ${parsed.target} -> ${parsed.backend}`,
        });
        return;
      }

      if (trimmed.startsWith("/")) {
        addCompleted({
          id: makeId("sys"),
          role: "system",
          content: `Unknown command: ${trimmed}  (type /help for commands)`,
        });
        return;
      }

      //  backend call

      // Lazy session creation — only materialise a session on the first real message.
      if (!sessionRef.current) {
        const s = createSession(runtimeConfig, "repl");
        sessionRef.current = s;
        saveSession(s);
      }

      // Write user message directly to stdout — bypasses Static to avoid cursor-tracking issues
      write(renderUserAnsi(trimmed));
      setBusy(true);
      liveRef.current = "";
      setActiveTool(null);
      setToolsSeen([]);
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      let semanticHits: MemoryFile[] = [];
      let semanticHitsWithScores: Array<{ file: MemoryFile; score: number }> =
        [];

      if (semanticCandidates.length > 0) {
        setEmbeddingBusy(true);
        try {
          semanticHitsWithScores = await semanticSearch(
            trimmed,
            semanticCandidates,
            5
          );
          semanticHits = semanticHitsWithScores.map((h) => h.file);
        } catch {
          // graceful degradation  semantic memories skipped
        }
        setEmbeddingBusy(false);
      }

      const sessionId = sessionRef.current?.id ?? "";

      // Replicate buildEnrichedPrompt's deduplication so the audit reflects
      // exactly what ends up in the prompt, not the raw input lists.
      const alwaysPaths = new Set(alwaysMemories.map((m) => m.filePath));
      const deduplicatedSemanticHits = semanticHitsWithScores.filter(
        (h) => !alwaysPaths.has(h.file.filePath)
      );

      const memoriesInjected = [
        ...alwaysMemories.map((m) => ({
          source: "always" as const,
          name: m.frontmatter.name,
          tier: m.tier,
          inject: m.frontmatter.inject,
        })),
        ...deduplicatedSemanticHits.map((h) => ({
          source: "semantic" as const,
          name: h.file.frontmatter.name,
          tier: h.file.tier,
          inject: h.file.frontmatter.inject,
          score: h.score,
        })),
      ];

      appendAuditEvent(sessionId, "prompt_sent", {
        userMessage: trimmed,
        memoriesInjected,
        historyTurnCount: histRef.current.length,
        backend: assistantBackend,
        utilityBackend: runtimeConfig.utilityBackend,
      });

      // Dedicated event so it's easy to grep the audit for memory-injected turns.
      if (memoriesInjected.length > 0) {
        appendAuditEvent(sessionId, "memories_injected", {
          count: memoriesInjected.length,
          always: memoriesInjected.filter((m) => m.source === "always").map((m) => m.name),
          semantic: deduplicatedSemanticHits.map((h) => ({
            name: h.file.frontmatter.name,
            score: h.score,
          })),
        });
      }

      const enriched = buildEnrichedPrompt(
        trimmed,
        alwaysMemories,
        semanticHits,
        histRef.current
      );

      let fullResponse = "";
      let finishedTools: string[] = [];
      let cancelled = false;
      let writeAfterCollapse: (() => void) | null = null;
      thinkingRef.current = { chars: 0, text: "" };
      try {
        const backendFn = getBackend(assistantBackend);
        for await (const event of backendFn(enriched, abortController.signal)) {
          if (event.type === "text") {
            fullResponse += event.content;
            liveRef.current = fullResponse;
          } else if (event.type === "thinking") {
            thinkingRef.current.chars += event.content.length;
            thinkingRef.current.text += event.content;
          } else if (event.type === "tool_call") {
            setActiveTool(event.name);
          } else if (event.type === "tool_done") {
            finishedTools = [...finishedTools, event.name];
            setToolsSeen(finishedTools);
            setActiveTool(null);
          }
        }

        if (!fullResponse.trim()) {
          throw new Error(
            `No response from ${assistantBackend}. Check the backend is installed and configured.`
          );
        }

        histRef.current.add("user", trimmed);
        histRef.current.add("assistant", fullResponse);

        const s = sessionRef.current;
        if (s) {
          s.turns.push({ role: "user", content: trimmed });
          s.turns.push({ role: "assistant", content: fullResponse });
          s.updatedAt = new Date().toISOString();
          const usedMems = [
            ...alwaysMemories.map((m) => ({
              name: m.frontmatter.name,
              tier: m.tier,
              inject: m.frontmatter.inject,
            })),
            ...semanticHits.map((m) => ({
              name: m.frontmatter.name,
              tier: m.tier,
              inject: m.frontmatter.inject,
            })),
          ];
          const seen = new Set<string>();
          s.memoriesActive = usedMems.filter((m) => {
            if (seen.has(m.name)) return false;
            seen.add(m.name);
            return true;
          });
          saveSession(s);
        }

        // Defer write until after setBusy(false) so Ink collapses the live area
        // before writing to stdout — prevents the status bar from appearing twice.
        writeAfterCollapse = () => write(renderAssistantAnsi(fullResponse));

        await compressHistoryIfNeeded(histRef.current, runtimeConfig);

        void extractMemories(
          trimmed,
          fullResponse,
          runtimeConfig,
          (count) => {
            setMemoryIndicator(`* saved ${count}`);
            setTimeout(() => setMemoryIndicator(null), 3000);
          },
          sessionId
        );
      } catch (err) {
        const isAbort =
          err instanceof Error &&
          (err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ERR_ABORTED");
        if (isAbort) {
          cancelled = true;
          // Show whatever partial text was received before the cancel
          if (fullResponse.trim()) {
            writeAfterCollapse = () => write(renderAssistantAnsi(fullResponse + "\n\n*[cancelled]*"));
            histRef.current.add("user", trimmed);
            histRef.current.add("assistant", fullResponse);
          } else {
            writeAfterCollapse = () => write(renderSystemAnsi("Cancelled."));
          }
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          writeAfterCollapse = () => write(renderSystemAnsi(`Error: ${msg}`));
        }
      } finally {
        abortControllerRef.current = null;
        setBusy(false);
        setStreamContent("");
        liveRef.current = "";
        setActiveTool(null);
        if (cancelled) setToolsSeen([]);
        // Defer write until after Ink re-renders with the live area collapsed,
        // preventing a stale Composer render from remaining on screen.
        const pendingWrite = writeAfterCollapse;
        if (pendingWrite) setImmediate(pendingWrite);
      }
    },
    [
      assistantBackend,
      alwaysMemories,
      semanticCandidates,
      runtimeConfig,
      refreshMemories,
      persistBackend,
      addCompleted,
      write,
      exit,
    ]
  );

  //  session picker overlay 

  if (showPicker) {
    return (
      <SessionPicker
        sessions={pickerSessions}
        onSelect={(resumed) => {
          setShowPicker(false);
          sessionRef.current = resumed;
          setAssistantBackend(resumed.backend);
          setRuntimeConfig((c) => ({ ...c, backend: resumed.backend }));
          histRef.current.clear();
          for (const t of resumed.turns) histRef.current.add(t.role, t.content);
          resumed.updatedAt = new Date().toISOString();
          saveSession(resumed);
          // Write session header + history directly to stdout (avoids Static clipping)
          write(renderSystemAnsi(`Switched to: ${resumed.name ?? resumed.id}`));
          for (const t of resumed.turns) {
            if (t.role === "user") write(renderUserAnsi(t.content));
            else if (t.role === "assistant") write(renderAssistantAnsi(t.content));
          }
          // Keep completed in sync for system-message rendering only
          addCompleted({
            id: makeId("sys"),
            role: "system",
            content: `Switched to: ${resumed.name ?? resumed.id}`,
          });
        }}
        onCancel={() => setShowPicker(false)}
      />
    );
  }

  //  main render 

  const isWorking = busy || embeddingBusy;
  const sessionLabel = sessionRef.current
    ? (sessionRef.current.name ?? sessionRef.current.id.slice(0, 10))
    : "";

  // Composer takes ~5 rows (status + border-top + input + border-bottom + hints).
  const COMPOSER_ROWS = 5;
  const toolHistoryRow = toolsSeen.length > 0 ? 1 : 0;
  const viewportRows = process.stdout.rows ?? 24;
  // Budget rows for the live area. When thinking is active (no response text yet),
  // split the budget: up to half for thinking lines, rest for margin/chrome.
  // Once response text arrives, collapse thinking to 1 summary line.
  const liveAreaBudget = Math.max(4, viewportRows - COMPOSER_ROWS - 2 - toolHistoryRow);
  const thinkingLinesBudget = streamContent ? 0 : Math.floor(liveAreaBudget / 2);
  const streamPreviewLines = streamContent
    ? liveAreaBudget - 1  // 1 row reserved for collapsed thinking summary if present
    : liveAreaBudget - thinkingLinesBudget;

  // Response text preview — only actual text, never thinking content.
  const streamPreview = streamContent
    ? streamContent.split("\n").slice(-streamPreviewLines).join("\n")
    : "";

  // Thinking display: live lines while reasoning, 1-line summary once response starts.
  const thinkingLines = thinkingPreview
    ? thinkingPreview.split("\n").slice(-thinkingLinesBudget).join("\n")
    : "";
  const thinkingSummary =
    thinkingChars > 0 && streamContent
      ? `reasoned for ${(thinkingChars / 1000).toFixed(1)}k chars`
      : null;

  return (
    <>
      {/*  Static: completed messages permanently printed to scrollback  */}
      <Static key={staticKey} items={completed}>
        {(msg) => <MessageBubble key={msg.id} message={msg} />}
      </Static>

      {/*  Live: shown while busy with content to display.
           Thinking streams as capped live lines; once response text arrives it
           collapses to a 1-line summary so the live area never overflows the viewport.  */}
      {isWorking && (streamPreview || thinkingLines || thinkingSummary || activeTool || toolsSeen.length > 0) && (
        <Box flexDirection="column" marginBottom={1} flexShrink={0}>
          <Box paddingLeft={1}>
            <Text color="greenBright" bold>
              rite
            </Text>
          </Box>
          {/* Thinking: live lines while reasoning */}
          {thinkingLines && (
            <Box paddingLeft={3}>
              <Text wrap="wrap" dimColor color="gray">
                {thinkingLines}
              </Text>
            </Box>
          )}
          {/* Thinking: collapsed summary once response text is flowing */}
          {thinkingSummary && (
            <Box paddingLeft={3}>
              <Text dimColor>
                {thinkingSummary}
              </Text>
            </Box>
          )}
          {/* Tool history: dim list of completed tool calls */}
          {toolsSeen.length > 0 && (
            <Box paddingLeft={3}>
              <Text dimColor>
                {"ran: " + toolsSeen.join(", ")}
              </Text>
            </Box>
          )}
          {/* Active tool or stream preview */}
          {(activeTool || streamPreview) && (
            <Box paddingLeft={3}>
              {streamPreview ? (
                <Text wrap="wrap" color="gray" dimColor>
                  {streamPreview}
                </Text>
              ) : (
                <Text dimColor>
                  {SPINNER[spinnerFrame]} tool: {activeTool}
                </Text>
              )}
            </Box>
          )}
        </Box>
      )}

      {/*  Fixed composer at bottom  flexShrink=0 ensures it never shrinks  */}
      <Composer
        value={input}
        onChange={(v) => {
          setInput(v);
          setHistoryIdx(null);
        }}
        onSubmit={(v) => void handleSubmit(v)}
        busy={isWorking}
        backend={assistantBackend}
        utilityBackend={runtimeConfig.utilityBackend}
        memoryCount={alwaysMemories.length}
        memoryIndicator={memoryIndicator}
        session={sessionLabel}
      />
    </>
  );
}

//  entry point 

export async function startRepl(
  backend: BackendName,
  historyLimit: number,
  config: RiteConfig,
  resumeSessionId?: string
): Promise<void> {
  const { waitUntilExit } = render(
    <Repl
      backend={backend}
      historyLimit={historyLimit}
      config={config}
      resumeSessionId={resumeSessionId}
    />
  );
  await waitUntilExit();
}
