import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
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
import { readImageFromClipboard, type ImageAttachment } from "./image.js";
import {
  setBackend,
  parseBackendTarget,
  type BackendTarget,
} from "../settings/backends.js";
import { updateConfig } from "../config/store.js";
import { setRiteApiKey } from "../backends/claude.js";
import { ApiKeyPrompt } from "./apikey-prompt.js";
import { setPasteHandler, installBracketedPaste, uninstallBracketedPaste } from "./paste.js";
import { Logo, LOGO_HEIGHT } from "./logo.js";
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

// Estimate terminal lines a rendered message will occupy. Used for viewport math.
// Intentionally generous (+2 buffer) to prevent over-filling the message box.
function estimateMessageLines(msg: Message, colWidth: number): number {
  const textWidth = Math.max(20, colWidth - 8);
  if (msg.role === "tool_call") {
    let h = 3; // icon + name row + margin
    if (msg.toolResult) {
      const resultLines = msg.toolResult.split("\n").filter((l) => l.trim());
      h += Math.min(4, resultLines.length) + (resultLines.length > 4 ? 1 : 0) + 1;
    }
    return h;
  }
  if (msg.role === "thinking") return 8; // header + bordered block preview + margin
  let h = 2; // role label + marginBottom
  for (const line of msg.content.split("\n")) {
    h += Math.max(1, Math.ceil((line.length || 1) / textWidth));
  }
  return h + 2; // +2 buffer for markdown/padding variance
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

  // Terminal dimensions — updated on resize via process.stdout
  const [termRows, setTermRows] = useState(() => process.stdout.rows || 24);
  const [termCols, setTermCols] = useState(() => process.stdout.columns || 80);
  useEffect(() => {
    const handler = () => {
      setTermRows(process.stdout.rows || 24);
      setTermCols(process.stdout.columns || 80);
    };
    process.stdout.on("resize", handler);
    return () => { process.stdout.off("resize", handler); };
  }, []);

  // All completed messages (no Static — we window them ourselves for alt screen)
  const [completed, setCompleted] = useState<Message[]>([]);

  // Scroll: 0 = newest at bottom; positive = scrolled up N messages from end
  const [scrollOffset, setScrollOffset] = useState(0);
  const atBottomRef = useRef(true);
  useEffect(() => { atBottomRef.current = scrollOffset === 0; }, [scrollOffset]);
  // Stay at bottom when new messages arrive (if we were already at bottom)
  const prevCompletedLenRef = useRef(0);
  useEffect(() => {
    if (completed.length !== prevCompletedLenRef.current) {
      prevCompletedLenRef.current = completed.length;
      if (atBottomRef.current) setScrollOffset(0);
    }
  }, [completed.length]);

  const [streamContent, setStreamContent] = useState("");
  const [thinkingChars, setThinkingChars] = useState(0);
  const [thinkingPreview, setThinkingPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [embeddingBusy, setEmbeddingBusy] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [activeTool, setActiveTool] = useState<string | null>(null);

  // Input
  const [input, setInput] = useState("");
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);

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
  const [showApiKeyPrompt, setShowApiKeyPrompt] = useState(false);
  const [pastedContent, setPastedContent] = useState<string | null>(null);

  // Refs (mutated during streaming, not tracked by React)
  const histRef = useRef(new ConversationHistory(historyLimit));
  const sessionRef = useRef<Session | null>(null);
  const liveRef = useRef("");
  const thinkingRef = useRef({ chars: 0, text: "" });
  const abortControllerRef = useRef<AbortController | null>(null);
  // Always-current mirrors of state values used in the useInput handler to avoid stale closures.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const pastedContentRef = useRef<string | null>(null);
  pastedContentRef.current = pastedContent;
  const inputRef = useRef(input);
  inputRef.current = input;
  // Type-ahead queue: messages typed while busy, auto-submitted when task finishes.
  const messageQueueRef = useRef<string[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);

  //  spinner + streaming poll (merged to reduce re-renders)

  useEffect(() => {
    if (!busy && !embeddingBusy) {
      setSpinnerFrame(0);
      liveRef.current = "";
      thinkingRef.current = { chars: 0, text: "" };
      setStreamContent("");
      setThinkingChars(0);
      setThinkingPreview("");
      return;
    }
    let lastContent = "";
    let lastThinkingChars = 0;
    let lastThinkingPreview = "";
    const t = setInterval(() => {
      // Advance spinner every tick.
      setSpinnerFrame((f) => (f + 1) % SPINNER.length);
      // Only push content state updates when the value actually changed —
      // avoids a re-render (and terminal cursor jump) on every tick.
      const content = liveRef.current;
      if (content !== lastContent) {
        lastContent = content;
        setStreamContent(content);
      }
      const chars = thinkingRef.current.chars;
      if (chars !== lastThinkingChars) {
        lastThinkingChars = chars;
        setThinkingChars(chars);
      }
      const preview = thinkingRef.current.text;
      if (preview !== lastThinkingPreview) {
        lastThinkingPreview = preview;
        setThinkingPreview(preview);
      }
    }, 150);
    return () => clearInterval(t);
  }, [busy, embeddingBusy]);

  // With Static+native scroll, content appends at bottom automatically.
  const snapToBottom = useCallback(() => {}, []);

  // Type-ahead queue drain: when busy transitions to false, auto-submit the next queued message.
  useEffect(() => {
    if (busy) return;
    const next = messageQueueRef.current.shift();
    if (next) {
      setQueuedCount(messageQueueRef.current.length);
      void handleSubmit(next);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  //  init 

  useEffect(() => {
    // Load stored API key into the SDK module (image-only path).
    // We deliberately do NOT write to process.env to prevent leaking the key
    // to claude CLI subprocesses or any other child process.
    const key = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (key) setRiteApiKey(key);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Register paste handler once — paste.ts intercepts bracketed paste sequences
  // before Ink sees them, so the full paste lands here in one setState call.
  useEffect(() => {
    setPasteHandler((text) => {
      setPastedContent(text);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleApiKeySave = useCallback((key: string) => {
    const next = updateConfig("global", { anthropicApiKey: key });
    setRiteApiKey(key); // SDK-only; not written to process.env
    setRuntimeConfig((c) => ({ ...c, anthropicApiKey: key }));
    setShowApiKeyPrompt(false);
    addCompleted({
      id: makeId("sys"),
      role: "system",
      content: `API key saved to ~/.rite/config.json`,
    });
    void next;
  }, [addCompleted]);

  //  keyboard: history nav + ctrl+c + image paste

  useInput((typed, key) => {
    // ctrl+c always exits
    if (key.ctrl && typed === "c") {
      exit();
      return;
    }

    // Escape: clear paste first; if busy and input has text, queue it (type-ahead);
    // if busy and no text, cancel in-progress request; if idle, no-op.
    if (key.escape) {
      if (pastedContentRef.current) {
        setPastedContent(null);
        return;
      }
      if (busyRef.current) {
        const current = inputRef.current.trim();
        if (current) {
          messageQueueRef.current.push(current);
          setQueuedCount(messageQueueRef.current.length);
          setInput("");
        } else {
          abortControllerRef.current?.abort();
        }
        return;
      }
      return;
    }

    // Ctrl+V — check clipboard for image before letting ink-text-input handle it
    if (key.ctrl && typed === "v") {
      const img = readImageFromClipboard();
      if (img) {
        setPendingImages((prev) => [...prev, img]);
        addCompleted({ id: makeId("sys"), role: "system", content: `Image attached: ${img.label}` });
        return; // consume the keypress — don't type into the text input
      }
      // No image on clipboard — tell the user so they know the key reached rite
      addCompleted({ id: makeId("sys"), role: "system", content: "ctrl+v: no image in clipboard (if this message never appears, your terminal is consuming the key)" });
    }

    // Ctrl+Shift+V — clear pending images
    if (key.ctrl && key.shift && typed === "V") {
      setPendingImages([]);
      return;
    }

    if (key.pageUp) {
      setScrollOffset((prev) => Math.min(Math.max(0, completed.length - 1), prev + Math.max(1, Math.floor(termRows / 4))));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((prev) => Math.max(0, prev - Math.max(1, Math.floor(termRows / 4))));
      return;
    }

    if (busy || showPicker || showApiKeyPrompt) return;

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
      const typed = value.trim();
      const pasted = pastedContent; // capture before clearing
      const images = pendingImages.slice(); // capture current images
      setInput("");
      setHistoryIdx(null);
      setDraft("");
      setPendingImages([]);
      setPastedContent(null);

      // Combine typed text with pasted content; slash commands ignore paste
      const trimmed =
        typed.startsWith("/") || !pasted
          ? typed
          : typed
          ? typed + "\n\n" + pasted
          : pasted;

      if (!trimmed && images.length === 0) return;
      if (!trimmed) return;

      // While busy: queue the message for auto-submission after current task finishes.
      if (busyRef.current) {
        messageQueueRef.current.push(trimmed);
        setQueuedCount(messageQueueRef.current.length);
        return;
      }

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
            "  /copy             copy last response to clipboard",
            "  /memory           show loaded memories",
            "  /backend          show current backends",
            "  /backend <name>   set assistant backend (claude | codex | copilot)",
            "  /backend assistant|utility <name>",
            "  /resume           switch session",
            "  /compact          compress conversation history",
            "  /apikey           set or update Anthropic API key",
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

      if (trimmed === "/copy") {
        // Find the last assistant message and copy to clipboard
        const lastAsst = [...completed].reverse().find((m) => m.role === "assistant");
        if (!lastAsst) {
          addCompleted({ id: makeId("sys"), role: "system", content: "No assistant response to copy." });
          return;
        }
        try {
          if (process.platform === "win32") {
            const { execFileSync } = await import("child_process");
            execFileSync("powershell", [
              "-NoProfile", "-NonInteractive", "-Command",
              `Set-Clipboard -Value ${JSON.stringify(lastAsst.content)}`
            ]);
          } else if (process.platform === "darwin") {
            const { execFileSync } = await import("child_process");
            const proc = execFileSync("pbcopy", { input: lastAsst.content });
            void proc;
          } else {
            const { execFileSync } = await import("child_process");
            execFileSync("xclip", ["-selection", "clipboard"], { input: lastAsst.content });
          }
          addCompleted({ id: makeId("sys"), role: "system", content: "✓ Copied last response to clipboard." });
        } catch {
          addCompleted({ id: makeId("sys"), role: "system", content: "✗ Failed to copy — clipboard not available." });
        }
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

      if (trimmed === "/apikey") {
        setShowApiKeyPrompt(true);
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
      addCompleted({ id: makeId("user"), role: "user", content: trimmed, images: images.length > 0 ? images : undefined });

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
        for await (const event of backendFn(enriched, abortController.signal, images.length > 0 ? images : undefined)) {
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
            // Keep activeTool showing — tool is still executing until tool_result arrives.
            // Only update if there are multiple concurrent tools (show the most recent remaining one).
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
            // Clear activeTool only when all pending tools have finished.
            if (pendingToolCalls.size === 0) setActiveTool(null);
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
            void autoNameSession(s.id, trimmed, fullResponse, runtimeConfig, (name) => {
              // Keep the in-memory session object in sync — without this, the next
              // saveSession(s) call would overwrite the disk file with name: null.
              if (sessionRef.current?.id === s.id) {
                sessionRef.current.name = name;
              }
            });
          }
        }

        appendAuditEvent(sessionId, "response_received", {
          rawResponse: fullResponse,
          backend: assistantBackend,
          charCount: fullResponse.length,
        });

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
        // Flush any tool calls that never received a result (e.g. on abort).
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
      pendingImages,
      pastedContent,
    ]
  );

  //  api key prompt overlay

  if (showApiKeyPrompt) {
    return (
      <ApiKeyPrompt
        currentKey={runtimeConfig.anthropicApiKey || process.env.ANTHROPIC_API_KEY}
        onSave={handleApiKeySave}
        onCancel={() => setShowApiKeyPrompt(false)}
      />
    );
  }

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

  const thinkingSummary =
    thinkingChars > 0 && streamContent
      ? `reasoned for ${(thinkingChars / 1000).toFixed(1)}k chars`
      : null;

  // Limit the live streaming preview to a fixed number of lines so the dynamic
  // area never grows unboundedly — a growing live area means Ink erases more lines
  // each re-render, causing the terminal cursor to jump further up and fighting
  // the user's scroll position (the "snap" bug).
  const LIVE_PREVIEW_LINES = 12;
  const streamPreview = (() => {
    if (!streamContent) return "";
    const lines = streamContent.split("\n");
    if (lines.length <= LIVE_PREVIEW_LINES) return streamContent;
    return lines.slice(-LIVE_PREVIEW_LINES).join("\n");
  })();

  const hasLiveArea = isWorking;

  // Composer height: status bar (1) + border+input box (3) + hints (1) + optionals + margin
  const composerHeight = 5
    + (pastedContent ? 1 : 0)
    + (pendingImages.length > 0 ? 1 : 0)
    + (queuedCount > 0 ? 1 : 0)
    + 1; // safety margin

  // Live area height when busy
  const liveAreaHeight = hasLiveArea ? (() => {
    let h = 2; // "rite" header + marginBottom
    if (thinkingPreview && !streamPreview) h += Math.min(LIVE_PREVIEW_LINES, thinkingPreview.split("\n").length);
    if (thinkingSummary) h += 1;
    if (activeTool) h += 1;
    if (streamPreview) h += streamPreview.split("\n").length;
    if (!streamPreview && !thinkingPreview && !activeTool) h += 1; // fallback spinner
    return h + 2; // safety margin
  })() : 0;

  const scrollIndicatorHeight = scrollOffset > 0 ? 1 : 0;
  const msgAreaHeight = Math.max(3, termRows - composerHeight - liveAreaHeight - scrollIndicatorHeight);

  // Total estimated lines for all completed messages — used to decide when to hide the logo
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const totalMessageLines = useMemo(
    () => completed.reduce((sum, msg) => sum + estimateMessageLines(msg, termCols), 0),
    [completed, termCols] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Logo is shown at startup and flushed once messages fill the viewport height
  const showLogo = scrollOffset === 0 && totalMessageLines < msgAreaHeight;
  const effectiveMsgAreaHeight = showLogo ? Math.max(3, msgAreaHeight - LOGO_HEIGHT) : msgAreaHeight;

  // Calculate which messages to show — work backwards from `endIdx` until we fill effectiveMsgAreaHeight
  const visibleMessages = useMemo(() => {
    const endIdx = Math.max(0, completed.length - scrollOffset);
    let usedLines = 0;
    const result: Message[] = [];
    for (let i = endIdx - 1; i >= 0; i--) {
      const lines = estimateMessageLines(completed[i], termCols);
      if (usedLines + lines > effectiveMsgAreaHeight && result.length > 0) break;
      usedLines += lines;
      result.unshift(completed[i]);
    }
    return result;
  }, [completed, scrollOffset, effectiveMsgAreaHeight, termCols]); // eslint-disable-line react-hooks/exhaustive-deps

  const hiddenAbove = Math.max(0, completed.length - scrollOffset - visibleMessages.length);
  const hiddenBelow = scrollOffset;

  return (
    <Box flexDirection="column" height={termRows}>
      {/* Scroll indicator — shown when there are messages above the viewport */}
      {scrollIndicatorHeight > 0 && (
        <Box paddingX={1}>
          <Text dimColor>
            {hiddenAbove > 0 ? `↑ ${hiddenAbove} message${hiddenAbove !== 1 ? "s" : ""} above` : "↑ top"}
            {hiddenBelow > 0 ? `  ↓ ${hiddenBelow} below` : ""}
            {"  pgup/pgdn to scroll"}
          </Text>
        </Box>
      )}

      {/* Message area — overflow:hidden clips anything that doesn't fit */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {showLogo && <Logo />}
        {visibleMessages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
      </Box>

      {/*  Live area — re-renders in place while assistant is working  */}
      {hasLiveArea && (
        <Box flexDirection="column" marginBottom={1}>
          <Box paddingLeft={1}>
            <Text color="greenBright" bold>rite</Text>
          </Box>
          {thinkingPreview && !streamPreview && (
            <Box paddingLeft={3}>
              <Text wrap="wrap" dimColor color="gray">{
                (() => {
                  const lines = thinkingPreview.split("\n");
                  return lines.length <= LIVE_PREVIEW_LINES
                    ? thinkingPreview
                    : lines.slice(-LIVE_PREVIEW_LINES).join("\n");
                })()
              }</Text>
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
          {streamPreview && (
            <Box paddingLeft={3}>
              <Text wrap="wrap">{streamPreview}</Text>
            </Box>
          )}
          {!streamPreview && !thinkingPreview && !activeTool && (
            <Box paddingLeft={3}>
              <Text dimColor>{SPINNER[spinnerFrame]}</Text>
            </Box>
          )}
        </Box>
      )}

      {/*  Composer — pinned to bottom  */}
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
        pendingImageCount={pendingImages.length}
        pastedContent={pastedContent}
        onClearPaste={() => setPastedContent(null)}
        queuedCount={queuedCount}
      />
    </Box>
  );
}

//  entry point 

export async function startRepl(
  backend: BackendName,
  historyLimit: number,
  config: RiteConfig,
  resumeSessionId?: string
): Promise<void> {
  installBracketedPaste(); // must run before render() so stdin is patched before Ink reads it
  process.stdout.write("\x1b[?1049h"); // enter alt screen
  process.stdout.write("\x1b[2J\x1b[H"); // clear alt screen, cursor to top-left
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
    uninstallBracketedPaste();
    process.stdout.write("\x1b[?25h"); // restore cursor
    process.stdout.write("\x1b[?1049l"); // exit alt screen (restores previous terminal content)
  }
}

