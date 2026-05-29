import React, { useState, useRef, useCallback, useEffect } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
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

  // All completed messages rendered in the ScrollView.
  const [completed, setCompleted] = useState<Message[]>([]);
  const scrollRef = useRef<ScrollViewRef>(null);
  const atBottomRef = useRef(true);

  // Terminal dimensions — updated on resize so layout recalculates.
  const [termSize, setTermSize] = useState({
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  });
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

  //  terminal resize + mouse scroll 

  useEffect(() => {
    const onResize = () => {
      setTermSize({ rows: process.stdout.rows ?? 24, cols: process.stdout.columns ?? 80 });
      scrollRef.current?.remeasure();
    };
    process.stdout.on("resize", onResize);
    return () => { process.stdout.off("resize", onResize); };
  }, []);

  // Mouse scroll — wire directly to ScrollView.scrollBy()
  // Negative delta = scroll up (reveal older messages).
  useEffect(() => {
    const handler = (dir: unknown) => {
      const delta = dir === "up" ? -3 : 3;
      if (dir === "up") atBottomRef.current = false;
      scrollRef.current?.scrollBy(delta);
      // Check if we scrolled back to bottom
      if (dir === "down") {
        setImmediate(() => {
          const ref = scrollRef.current;
          if (ref && ref.getScrollOffset() >= ref.getBottomOffset()) {
            atBottomRef.current = true;
          }
        });
      }
    };
    process.stdin.on("mouse_scroll", handler);
    return () => { process.stdin.off("mouse_scroll", handler); };
  }, []);


  const snapToBottom = useCallback(() => {
    atBottomRef.current = true;
    scrollRef.current?.scrollToBottom();
  }, []);

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
        const turns: Message[] = resumed.turns.map((t) => ({
          id: makeId(t.role),
          role: t.role as MessageRole,
          content: t.content,
        }));
        setCompleted([
          { id: makeId("sys"), role: "system", content: `Resumed: ${resumed.name ?? resumed.id}` },
          ...turns,
        ]);
      } catch {
        const s = createSession(config, "repl");
        sessionRef.current = s;
        saveSession(s);
        setCompleted([
          { id: makeId("sys"), role: "system", content: `Session not found. Starting fresh.` },
        ]);
      }
    }
    // No else branch — session is created lazily on first message submit.
  }, [config, resumeSessionId]);

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
        // Clear completed and snap back to bottom
        setCompleted([
          { id: makeId("sys"), role: "system", content: "Context cleared." },
        ]);
        snapToBottom();
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
      // Snap to bottom and add user message immediately.
      snapToBottom();
      addCompleted({ id: makeId("user"), role: "user", content: trimmed });

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
      let pendingMsg: Message | null = null;
      // Track current thinking block — emitted to completed when the block ends.
      let pendingThinkingText = "";
      // Hold tool calls until we have the result (then emit as one message).
      const pendingToolCalls = new Map<string, { name: string; inputJson: string; startedAt: number }>();
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
            flushThinking();
            fullResponse += event.content;
            liveRef.current = fullResponse;
          } else if (event.type === "thinking") {
            pendingThinkingText += event.content;
            thinkingRef.current.chars += event.content.length;
            thinkingRef.current.text = pendingThinkingText;
          } else if (event.type === "tool_call") {
            flushThinking();
            pendingToolCalls.set(event.id, { name: event.name, inputJson: "", startedAt: Date.now() });
            setActiveTool(event.name);
          } else if (event.type === "tool_done") {
            const pending = pendingToolCalls.get(event.id);
            if (pending) pending.inputJson = event.inputJson ?? "";
            setActiveTool(null);
          } else if (event.type === "tool_result") {
            const pending = pendingToolCalls.get(event.id);
            if (pending) {
              pendingToolCalls.delete(event.id);
              addCompleted({
                id: makeId("tool"),
                role: "tool_call",
                content: pending.name,
                toolName: pending.name,
                toolInputJson: pending.inputJson,
                toolResult: event.result,
                toolIsError: event.isError,
                durationMs: Date.now() - pending.startedAt,
              });
            }
          }
        }

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

          if (isFirstTurn && s.name == null) {
            void autoNameSession(s.id, trimmed, fullResponse, runtimeConfig);
          }
        }

        pendingMsg = { id: makeId("asst"), role: "assistant", content: fullResponse };

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
          if (fullResponse.trim()) {
            pendingMsg = { id: makeId("asst"), role: "assistant", content: fullResponse + "\n\n*[cancelled]*" };
            histRef.current.add("user", trimmed);
            histRef.current.add("assistant", fullResponse);
          } else {
            pendingMsg = { id: makeId("sys"), role: "system", content: "Cancelled." };
          }
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          pendingMsg = { id: makeId("sys"), role: "system", content: `Error: ${msg}` };
        }
      } finally {
        abortControllerRef.current = null;
        for (const [, pending] of pendingToolCalls) {
          addCompleted({
            id: makeId("tool"),
            role: "tool_call",
            content: pending.name,
            toolName: pending.name,
            toolInputJson: pending.inputJson,
            durationMs: Date.now() - pending.startedAt,
          });
        }
        pendingToolCalls.clear();
        setBusy(false);
        setStreamContent("");
        liveRef.current = "";
        setActiveTool(null);
        if (pendingMsg) addCompleted(pendingMsg);
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
      snapToBottom,
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
          snapToBottom();
          setCompleted([
            { id: makeId("sys"), role: "system", content: `Switched to: ${resumed.name ?? resumed.id}` },
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

  const viewportRows = termSize.rows;

  const thinkingSummary =
    thinkingChars > 0 && streamContent
      ? `reasoned for ${(thinkingChars / 1000).toFixed(1)}k chars`
      : null;

  const hasLiveArea = isWorking && !!(streamContent || thinkingPreview || thinkingSummary || activeTool);

  return (
    <Box flexDirection="column" height={viewportRows}>
      {/*  All messages + live area in one unified ScrollView  */}
      <ScrollView
        ref={scrollRef}
        flexGrow={1}
        onScroll={(scrollTop) => {
          const ref = scrollRef.current;
          if (ref) {
            atBottomRef.current = scrollTop >= ref.getBottomOffset();
          }
        }}
        onContentHeightChange={() => {
          if (atBottomRef.current) {
            scrollRef.current?.scrollToBottom();
          }
        }}
      >
        {completed.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {hasLiveArea && (
          <Box key="__live__" flexDirection="column" marginBottom={1}>
            <Box paddingLeft={1}>
              <Text color="greenBright" bold>rite</Text>
            </Box>
            {thinkingPreview && !streamContent && (
              <Box paddingLeft={3}>
                <Text wrap="wrap" dimColor color="gray">{thinkingPreview}</Text>
              </Box>
            )}
            {thinkingSummary && (
              <Box paddingLeft={3}>
                <Text dimColor>{thinkingSummary}</Text>
              </Box>
            )}
            {activeTool && (
              <Box paddingLeft={3}>
                <Text dimColor>{SPINNER[spinnerFrame]} {activeTool}</Text>
              </Box>
            )}
            {streamContent && (
              <Box paddingLeft={3}>
                <Text wrap="wrap" color="gray" dimColor>{streamContent}</Text>
              </Box>
            )}
          </Box>
        )}
      </ScrollView>

      {/*  Composer — always at bottom  */}
      <Composer
        value={input}
        onChange={(v) => { setInput(v); setHistoryIdx(null); }}
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

const ALT_ENTER = "\x1b[?1049h\x1b[H\x1b[2J"; // enter alt screen, clear, cursor home
const ALT_EXIT  = "\x1b[?1049l";               // exit alt screen → restores original buffer

// Intercepts process.stdin.push() — the point where OS bytes enter the readable
// buffer. Strips raw SGR mouse sequences before Ink reads them, and emits a
// custom 'mouse_scroll' event on stdin that the Repl component listens to.
function installStdinMouseFilter(): () => void {
  const SGR_RE = /\x1b\[<\d+;\d+;\d+[Mm]/g;
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
      const filtered = str.replace(SGR_RE, "");
      if (!filtered) return true;
      chunk = Buffer.isBuffer(chunk) ? Buffer.from(filtered, "binary") : filtered;
    }
    return origPush(chunk, encoding);
  };

  return () => {
    (process.stdin as unknown as Record<string, unknown>).push = origPush;
  };
}

export async function startRepl(
  backend: BackendName,
  historyLimit: number,
  config: RiteConfig,
  resumeSessionId?: string
): Promise<void> {
  // Enter alt screen (own buffer — original terminal content restored on exit)
  process.stdout.write(ALT_ENTER);
  // Enable SGR mouse reporting so scroll-wheel events reach stdin as sequences
  process.stdout.write("\x1b[?1000h\x1b[?1006h");

  const uninstall = installStdinMouseFilter();

  const cleanup = () => {
    uninstall();
    process.stdout.write("\x1b[?1000l\x1b[?1006l"); // disable mouse reporting
    process.stdout.write(ALT_EXIT);
  };

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

