import React, { useState, useRef, useCallback, useEffect } from "react";
import { render, Box, Text, useApp, useInput, useStdin } from "ink";
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
import { autoNameSession } from "../sessions/namer.js";
import { SessionPicker } from "../sessions/picker.js";
import { appendAuditEvent } from "../audit/writer.js";
import { Composer } from "./composer.js";
import { MessageBubble, type Message, type MessageRole } from "./message.js";
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

// Estimate how many terminal rows a message will occupy (rough but good enough).
function estimateMsgLines(msg: Message, termWidth: number): number {
  const content = msg.content || "";
  const rawLines = content.split("\n");
  let total = 0;
  for (const line of rawLines) {
    total += Math.max(1, Math.ceil(line.length / Math.max(1, termWidth - 8)));
  }
  return total + 2; // +2 for heading row + bottom margin
}

// Return the slice of completed messages that fits in viewportHeight lines,
// skipping scrollMsgs messages from the bottom (0 = show latest).
// Using message-count scroll (not lines) gives 1-message-per-tick precision.
function getVisibleMessages(
  completed: Message[],
  scrollMsgs: number,
  viewportHeight: number,
  termWidth: number
): { messages: Message[]; hasMore: boolean } {
  if (completed.length === 0) return { messages: [], hasMore: false };

  // endIdx: skip scrollMsgs messages from the bottom.
  const endIdx = Math.max(0, completed.length - scrollMsgs);

  // Walk backwards from endIdx, fitting as many messages as possible.
  let shown = 0;
  let startIdx = endIdx;
  for (let i = endIdx - 1; i >= 0; i--) {
    const n = estimateMsgLines(completed[i], termWidth);
    if (shown + n > viewportHeight) break;
    shown += n;
    startIdx = i;
  }

  return {
    messages: completed.slice(startIdx, endIdx),
    hasMore: endIdx < completed.length,
  };
}

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

  // Completed messages (all rendered via React, no write() to stdout).
  const [completed, setCompleted] = useState<Message[]>([]);
  const [scrollOffset, setScrollOffset] = useState(0); // messages hidden from the bottom (0=latest)
  const atBottomRef = useRef(true); // true when the user hasn't manually scrolled up

  // Live area
  const [streamContent, setStreamContent] = useState("");
  const [thinkingChars, setThinkingChars] = useState(0);
  const [thinkingPreview, setThinkingPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [embeddingBusy, setEmbeddingBusy] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  // Tool call tracking for live display
  const [activeTool, setActiveTool] = useState<string | null>(null);

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
        // Load resumed session history directly into completed messages.
        setCompleted([
          {
            id: makeId("sys"),
            role: "system",
            content: `Resumed: ${resumed.name ?? resumed.id}`,
          },
          ...resumed.turns.map((t) => ({
            id: makeId(t.role),
            role: t.role as MessageRole,
            content: t.content,
          })),
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
  }, [config, resumeSessionId]);

  //  helpers 

  const addCompleted = useCallback((msg: Message) => {
    setCompleted((prev) => [...prev, msg]);
  }, []);

  const updateCompleted = useCallback((id: string, patch: Partial<Message>) => {
    setCompleted((prev) => prev.map((m) => m.id === id ? { ...m, ...patch } : m));
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

  //  mouse scroll handler (custom event emitted by startRepl's stdin patch) 

  const { stdin } = useStdin();
  useEffect(() => {
    if (!stdin) return;
    const handler = (direction: "up" | "down") => {
      if (direction === "up") {
        setScrollOffset((prev) => prev + 1);
        atBottomRef.current = false;
      } else {
        setScrollOffset((prev) => {
          const next = Math.max(0, prev - 1);
          atBottomRef.current = next === 0;
          return next;
        });
      }
    };
    (stdin as NodeJS.EventEmitter).on("mouse_scroll", handler);
    return () => { (stdin as NodeJS.EventEmitter).off("mouse_scroll", handler); };
  }, [stdin]);

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
        // Reset scroll position when clearing
        setScrollOffset(0);
        atBottomRef.current = true;
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

      setBusy(true);
      liveRef.current = "";
      setActiveTool(null);
      // Add user message to completed immediately (React batches state updates).
      addCompleted({ id: makeId("user"), role: "user", content: trimmed });
      // Auto-scroll to bottom when user sends a message.
      setScrollOffset(0);
      atBottomRef.current = true;

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
      let cancelled = false;
      let completedMsg: Message | null = null;
      // Track current thinking block — emitted to completed when the block ends.
      let pendingThinkingText = "";
      // Track in-flight tool calls: id → { msgId, name, inputJson, startedAt }
      const pendingToolCalls = new Map<string, { msgId: string; name: string; inputJson: string; startedAt: number }>();
      thinkingRef.current = { chars: 0, text: "" };

      /** Flush the current thinking block to completed and reset live tracking. */
      const flushThinking = () => {
        if (!pendingThinkingText.trim()) return;
        addCompleted({ id: makeId("think"), role: "thinking", content: pendingThinkingText });
        pendingThinkingText = "";
        thinkingRef.current = { chars: 0, text: "" };
      };

      try {
        const backendFn = getBackend(assistantBackend);
        for await (const event of backendFn(enriched, abortController.signal)) {
          if (event.type === "text") {
            // Thinking block ends when response text begins.
            flushThinking();
            fullResponse += event.content;
            liveRef.current = fullResponse;
          } else if (event.type === "thinking") {
            pendingThinkingText += event.content;
            thinkingRef.current.chars += event.content.length;
            thinkingRef.current.text = pendingThinkingText;
          } else if (event.type === "tool_call") {
            // Thinking block ends when a tool call starts.
            flushThinking();
            const msgId = makeId("tool");
            // Add immediately so the tool call appears in the viewport right away.
            addCompleted({
              id: msgId,
              role: "tool_call",
              content: event.name,
              toolName: event.name,
            });
            pendingToolCalls.set(event.id, { msgId, name: event.name, inputJson: "", startedAt: Date.now() });
            setActiveTool(event.name);
          } else if (event.type === "tool_done") {
            const pending = pendingToolCalls.get(event.id);
            if (pending) {
              pending.inputJson = event.inputJson ?? "";
              updateCompleted(pending.msgId, { toolInputJson: pending.inputJson });
            }
            setActiveTool(null);
          } else if (event.type === "tool_result") {
            const pending = pendingToolCalls.get(event.id);
            if (pending) {
              pendingToolCalls.delete(event.id);
              updateCompleted(pending.msgId, {
                toolInputJson: pending.inputJson,
                toolResult: event.result,
                toolIsError: event.isError,
                durationMs: Date.now() - pending.startedAt,
              });
            }
          }
        }

        // Flush any trailing thinking block (e.g. model thought then gave no text).
        flushThinking();

        if (!fullResponse.trim()) {
          throw new Error(
            `No response from ${assistantBackend}. Check the backend is installed and configured.`
          );
        }

        histRef.current.add("user", trimmed);
        histRef.current.add("assistant", fullResponse);

        const s = sessionRef.current;
        if (s) {
          const isFirstTurn = s.turns.length === 0;
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

          // Auto-name the session after the first turn.
          if (isFirstTurn && s.name == null) {
            void autoNameSession(s.id, trimmed, fullResponse, runtimeConfig);
          }
        }

        // Queue the assistant response to be added to completed in the finally block.
        completedMsg = { id: makeId("asst"), role: "assistant", content: fullResponse };

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
            completedMsg = { id: makeId("asst"), role: "assistant", content: fullResponse + "\n\n*[cancelled]*" };
            histRef.current.add("user", trimmed);
            histRef.current.add("assistant", fullResponse);
          } else {
            completedMsg = { id: makeId("sys"), role: "system", content: "Cancelled." };
          }
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          completedMsg = { id: makeId("sys"), role: "system", content: `Error: ${msg}` };
        }
      } finally {
        abortControllerRef.current = null;
        // Patch any tool calls that never got a result (already in completed, just missing result).
        for (const [, pending] of pendingToolCalls) {
          updateCompleted(pending.msgId, {
            toolInputJson: pending.inputJson,
            durationMs: Date.now() - pending.startedAt,
          });
        }
        pendingToolCalls.clear();
        if (completedMsg) addCompleted(completedMsg);
        setBusy(false);
        setStreamContent("");
        liveRef.current = "";
        setActiveTool(null);
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
      updateCompleted,
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
          refreshMemories();
          // Reset scroll position and load session history into completed.
          setScrollOffset(0);
          atBottomRef.current = true;
          setCompleted([
            {
              id: makeId("sys"),
              role: "system",
              content: `Switched to: ${resumed.name ?? resumed.id}`,
            },
            ...resumed.turns.map((t) => ({
              id: makeId(t.role),
              role: t.role as MessageRole,
              content: t.content,
            })),
          ]);
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
  const viewportRows = process.stdout.rows ?? 24;
  const termWidth = process.stdout.columns ?? 80;

  // Budget rows for the live area. When thinking is active (no response text yet),
  // split the budget: up to half for thinking lines, rest for margin/chrome.
  // Once response text arrives, collapse thinking to 1 summary line.
  const liveAreaBudget = Math.max(4, viewportRows - COMPOSER_ROWS - 2);
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

  // Viewport: leave room for live area (when working) + composer + 1 row margin.
  const liveAreaRows = isWorking ? liveAreaBudget : 0;
  const chatViewportRows = Math.max(2, viewportRows - COMPOSER_ROWS - liveAreaRows - 1);
  const { messages: visibleMessages, hasMore } = getVisibleMessages(
    completed,
    scrollOffset,
    chatViewportRows,
    termWidth
  );

  return (
    <Box flexDirection="column" height={viewportRows}>
      {/*  Scrollable message viewport  */}
      <Box flexDirection="column" flexGrow={1}>
        {visibleMessages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
      </Box>

      {/*  Scroll indicator — visible when scrolled up with newer messages below  */}
      {hasMore && (
        <Box paddingLeft={2}>
          <Text dimColor>↓  scroll down for latest  (wheel or PgDn)</Text>
        </Box>
      )}

      {/*  Live: shown while busy with content to display.
           Thinking streams as capped live lines; once response text arrives it
           collapses to a 1-line summary so the live area never overflows the viewport.
           Completed tool calls and thinking blocks land in the viewport above.  */}
      {isWorking && (streamPreview || thinkingLines || thinkingSummary || activeTool) && (
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
          {/* Active tool indicator (shown independently of text preview) */}
          {activeTool && (
            <Box paddingLeft={3}>
              <Text dimColor>
                {SPINNER[spinnerFrame]} {activeTool}
              </Text>
            </Box>
          )}
          {/* Stream preview */}
          {streamPreview && (
            <Box paddingLeft={3}>
              <Text wrap="wrap" color="gray" dimColor>
                {streamPreview}
              </Text>
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
    </Box>
  );
}

//  entry point 

const ALT_ENTER   = "\x1b[?1049h\x1b[H\x1b[2J"; // enter alt screen, cursor home, clear
const ALT_EXIT    = "\x1b[?1049l";               // exit alt screen (restores original buffer)
const MOUSE_ENTER = "\x1b[?1000h\x1b[?1006h";   // enable SGR mouse (button + scroll events)
const MOUSE_EXIT  = "\x1b[?1000l\x1b[?1006l";   // disable SGR mouse

const SGR_MOUSE_RE = /\x1b\[<\d+;\d+;\d+[Mm]/g;

// Patch process.stdin.push() BEFORE render() — this intercepts data at the
// stream buffer level, BEFORE Ink reads it, without needing a Transform/pipe.
// Ink uses .read()/.readable to pull data from the buffer; patching push()
// ensures filtered data enters the buffer, so Ink never sees raw mouse bytes.
// Scroll events are emitted on process.stdin as a custom 'mouse_scroll' event.
function installStdinMouseFilter(): () => void {
  const origPush = (process.stdin.push as (...a: unknown[]) => boolean).bind(process.stdin);

  (process.stdin as unknown as Record<string, unknown>).push = function (
    chunk: Buffer | string | null,
    encoding?: BufferEncoding
  ): boolean {
    if (chunk !== null && chunk !== undefined) {
      const str = Buffer.isBuffer(chunk) ? chunk.toString("binary") : String(chunk);
      for (const m of str.matchAll(/\x1b\[<(\d+);\d+;\d+M/g)) {
        const code = parseInt(m[1], 10);
        if (code === 64) process.stdin.emit("mouse_scroll", "up");
        else if (code === 65) process.stdin.emit("mouse_scroll", "down");
      }
      const filtered = str.replace(SGR_MOUSE_RE, "");
      if (!filtered) return true; // nothing to push, backpressure: OK
      chunk = Buffer.isBuffer(chunk) ? Buffer.from(filtered, "binary") : filtered;
    }
    return origPush(chunk, encoding);
  };

  return () => {
    // Restore original push on cleanup.
    (process.stdin as unknown as Record<string, unknown>).push = origPush;
  };
}

export async function startRepl(
  backend: BackendName,
  historyLimit: number,
  config: RiteConfig,
  resumeSessionId?: string
): Promise<void> {
  // Switch to alternate screen buffer — same UX as claude code / copilot CLI.
  process.stdout.write(ALT_ENTER);
  // Enable SGR mouse reporting so scroll-wheel events arrive as mouse sequences
  // instead of being converted to up/down arrow keys.
  process.stdout.write(MOUSE_ENTER);

  // Patch stdin.push() BEFORE render() so Ink never sees raw SGR mouse bytes.
  // (push() intercepts data before it enters the buffer; Ink reads from the buffer.)
  const uninstallMouseFilter = installStdinMouseFilter();

  const cleanup = () => {
    uninstallMouseFilter();
    process.stdout.write(MOUSE_EXIT);
    process.stdout.write(ALT_EXIT);
  };

  // Ensure the screen is restored on any exit path.
  const onExit = () => cleanup();
  const onSignal = () => { cleanup(); process.exit(0); };
  process.once("exit", onExit);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const { waitUntilExit } = render(
      <Repl
        backend={backend}
        historyLimit={historyLimit}
        config={config}
        resumeSessionId={resumeSessionId}
      />
    );
    await waitUntilExit();
  } finally {
    cleanup();
    process.off("exit", onExit);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
