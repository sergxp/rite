import React, { useState, useRef, useCallback, useEffect } from "react";
import { render, Box, Text, useApp, useInput, measureElement } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { ConversationHistory } from "./history.js";
import { buildEnrichedPrompt } from "./enricher.js";
import { loadMemories } from "../memory/reader.js";
import { semanticSearch } from "../memory/embeddings.js";
import { getBackend, type BackendEvent } from "../backends/index.js";
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
import { subscribeTick } from "./spinner.js";
import { Composer, type ComposerHandle, type ComposerMetrics } from "./composer.js";
import { MessageBubble, type Message, type MessageRole } from "./message.js";
import { MarkdownMessage } from "./markdown.js";
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
import { LoopPicker } from "./loop-picker.js";
import { loadLoops } from "../loops/registry.js";
import { runLoopTui } from "../loops/runner.js";
import { checkMemoryCompliance, TOOL_EVIDENCE_HEADER } from "../loops/default-review.js";
import type { BackendName, RiteConfig } from "../config/types.js";
import type { MemoryFile } from "../memory/types.js";
import type { Session } from "../sessions/types.js";
import type { Loop } from "../loops/types.js";

//  helpers 

let _seq = 0;
function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${_seq++}`;
}

const RENDERED_MSG_CAP = 150;

const SLASH_COMMANDS = [
  "/help", "/clear", "/copy", "/memory", "/resume",
  "/compact", "/apikey", "/exit", "/backend", "/loop", "/loop off",
];


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

// Streaming bubble — rendered as the last child inside ScrollView while the
// assistant is working. Shows step label, thinking preview, active tool, and
// the accumulating response text in real time.
interface StreamingState {
  content: string;
  activeTool: string | null;
  stepLabel: string;
  thinkingText: string;
  thinkingChars: number;
}

function StreamingBubble({
  liveRef,
  activeToolRef,
  stepLabelRef,
  thinkingRef,
}: {
  liveRef: React.MutableRefObject<string>;
  activeToolRef: React.MutableRefObject<string | null>;
  stepLabelRef: React.MutableRefObject<string>;
  thinkingRef: React.MutableRefObject<{ chars: number; text: string }>;
}) {
  const [state, setState] = useState<StreamingState>(() => ({
    content: liveRef.current,
    activeTool: activeToolRef.current,
    stepLabel: stepLabelRef.current,
    thinkingText: thinkingRef.current.text,
    thinkingChars: thinkingRef.current.chars,
  }));

  // Subscribe to the same timer tick as the Composer spinner. Both setState calls
  // fire in the same synchronous loop → React 18 batches → 1 render commit per tick.
  useEffect(() => {
    return subscribeTick(() => {
      setState({
        content: liveRef.current,
        activeTool: activeToolRef.current,
        stepLabel: stepLabelRef.current,
        thinkingText: thinkingRef.current.text,
        thinkingChars: thinkingRef.current.chars,
      });
    });
  }, [liveRef, activeToolRef, stepLabelRef, thinkingRef]);

  const thinkingSummary =
    state.thinkingChars > 0 && state.content
      ? `reasoned for ${(state.thinkingChars / 1000).toFixed(1)}k chars`
      : null;

  return (
    <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
      {state.stepLabel && (
        <Text dimColor>→ {state.stepLabel}</Text>
      )}
      {state.thinkingText && !state.content && (
        <Text wrap="wrap" dimColor>
          {state.thinkingText.split("\n").slice(-8).join("\n")}
        </Text>
      )}
      {thinkingSummary && (
        <Text dimColor>{thinkingSummary}</Text>
      )}
      {state.activeTool && (
        <Text dimColor>⏳ {state.activeTool}</Text>
      )}
      {state.content && (
        <MarkdownMessage content={state.content} />
      )}
      {!state.content && !state.thinkingText && !state.activeTool && (
        <Text dimColor>…</Text>
      )}
    </Box>
  );
}

// Wraps MessageBubble with Yoga measurement. Reports (id, height) on every
// content/visibility change so the parent can window off-screen messages.
const MeasuredBubble = React.memo(function MeasuredBubble({
  message,
  thinkingExpanded,
  toolsExpanded,
  onMeasure,
}: {
  message: Message;
  thinkingExpanded: boolean;
  toolsExpanded: boolean;
  onMeasure: (id: string, height: number) => void;
}) {
  const ref = useRef<Parameters<typeof measureElement>[0]>(null);
  useEffect(() => {
    if (ref.current) {
      const { height } = measureElement(ref.current);
      onMeasure(message.id, height);
    }
  }, [message.id, message.content, message.toolResult, thinkingExpanded, toolsExpanded, onMeasure]);

  return (
    <Box ref={ref} flexDirection="column">
      <MessageBubble message={message} thinkingExpanded={thinkingExpanded} toolsExpanded={toolsExpanded} />
    </Box>
  );
});

type PendingTool = { name: string; inputJson: string; startedAt: number };

/**
 * Drains a backend event stream, updating shared UI refs and accumulating tool evidence.
 * Accepts optional callbacks for the behaviours that differ between the main turn and
 * correction turns: flushing thinking to completed (onPreText), accumulating raw thinking
 * text (onThinkingDelta), and emitting tool-call UI bubbles (onToolResult).
 * Returns the accumulated text response.
 */
async function drainAgentStream(
  stream: AsyncIterable<BackendEvent>,
  opts: {
    pendingTools: Map<string, PendingTool>;
    completedToolCalls: string[];
    activeToolRef: { current: string | null };
    thinkingRef: { current: { chars: number; text: string } };
    liveRef: { current: string };
    onSessionId(id: string): void;
    onPreText?(): void;
    onThinkingDelta?(delta: string): void;
    onToolResult?(tool: PendingTool, result: string, isError: boolean): void;
  }
): Promise<string> {
  let accumulated = "";
  let accumulatedThinking = "";
  for await (const event of stream) {
    if (event.type === "session_id") {
      opts.onSessionId(event.sessionId);
    } else if (event.type === "text") {
      opts.onPreText?.();
      accumulated += event.content;
      opts.liveRef.current = accumulated;
    } else if (event.type === "thinking") {
      accumulatedThinking += event.content;
      opts.thinkingRef.current.chars += event.content.length;
      opts.thinkingRef.current.text = accumulatedThinking;
      opts.onThinkingDelta?.(event.content);
    } else if (event.type === "tool_call") {
      opts.onPreText?.();
      opts.pendingTools.set(event.id, { name: event.name, inputJson: "", startedAt: Date.now() });
      opts.activeToolRef.current = event.name;
    } else if (event.type === "tool_done") {
      const p = opts.pendingTools.get(event.id);
      if (p) p.inputJson = event.inputJson ?? "";
    } else if (event.type === "tool_result") {
      const p = opts.pendingTools.get(event.id);
      if (p) {
        opts.pendingTools.delete(event.id);
        const snippet = (event.result ?? "").slice(0, 300);
        opts.completedToolCalls.push(`[${p.name}(${p.inputJson.slice(0, 200)}) → ${snippet}]`);
        opts.onToolResult?.(p, event.result ?? "", event.isError);
      }
      if (opts.pendingTools.size === 0) opts.activeToolRef.current = null;
    }
  }
  return accumulated;
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
      scrollRef.current?.remeasure();
    };
    process.stdout.on("resize", handler);
    return () => { process.stdout.off("resize", handler); };
  }, []);

  // All completed messages (no Static — we window them ourselves for alt screen)
  const [completed, setCompleted] = useState<Message[]>([]);

  // ScrollView ref — all scroll control goes through ink-scroll-view (true line-level smooth scroll)
  const scrollRef = useRef<ScrollViewRef>(null);
  const atBottomRef = useRef(true);
  // Tracks current message area height so keyboard scroll handlers can use proportional steps
  const msgAreaHeightRef = useRef(10);


  const [busy, setBusy] = useState(false);
  // Global visibility toggles for thinking blocks and tool results (ctrl+t / ctrl+o)
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [embeddingBusy, setEmbeddingBusy] = useState(false);
  const activeToolRef = useRef<string | null>(null);
  const stepLabelRef = useRef("");

  // Input — managed inside Composer; Repl only tracks history for passing down
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const composerRef = useRef<ComposerHandle>(null);
  const autocompleteActiveRef = useRef(false);
  // Layout metrics from Composer — only updates when layout actually changes (not every keystroke)
  const [composerMetrics, setComposerMetrics] = useState<ComposerMetrics>({
    inputLines: 1,
    hasAutocomplete: false,
    hasText: false,
  });
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);

  // Virtual windowing: track per-message Yoga heights so off-screen messages
  // can be replaced with equal-height spacers, reducing mounted node count.
  const msgHeightsRef = useRef<Map<string, number>>(new Map());
  const scrollOffsetRef = useRef(0);
  const [, setWindowVersion] = useState(0);
  const handleMeasure = useCallback((id: string, height: number) => {
    const map = msgHeightsRef.current;
    if (map.get(id) !== height) {
      map.set(id, height);
      setWindowVersion((v) => v + 1);
    }
  }, []);

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
  const [activeLoop, setActiveLoop] = useState<Loop | null>(null);
  const [showLoopPicker, setShowLoopPicker] = useState(false);
  const [loopPickerLoops, setLoopPickerLoops] = useState<Loop[]>([]);
  // Resolves when the user submits a message while the loop runner is awaiting input
  const loopInputResolverRef = useRef<((s: string) => void) | null>(null);
  const loopTokenAccRef = useRef<string>("");

  // Refs (mutated during streaming, not tracked by React)
  const histRef = useRef(new ConversationHistory(historyLimit));
  const sessionRef = useRef<Session | null>(null);
  // Persistent Claude session ID — captured from the first call's system/init event.
  // Subsequent calls pass --resume so all turns share one Claude Code session.
  const claudeSessionIdRef = useRef<string | null>(null);
  const liveRef = useRef("");
  const thinkingRef = useRef({ chars: 0, text: "" });
  const abortControllerRef = useRef<AbortController | null>(null);
  // Always-current mirrors of state values used in the useInput handler to avoid stale closures.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const pastedContentRef = useRef<string | null>(null);
  pastedContentRef.current = pastedContent;
  // Type-ahead queue: messages typed while busy, auto-submitted when task finishes.
  const messageQueueRef = useRef<string[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);

  // Clear streaming refs when idle so stale content doesn't flash on next request.
  useEffect(() => {
    if (!busy && !embeddingBusy) {
      liveRef.current = "";
      thinkingRef.current = { chars: 0, text: "" };
      activeToolRef.current = null;
      stepLabelRef.current = "";
    }
  }, [busy, embeddingBusy]);

  // Scroll to bottom imperatively (used after session load, sending message, etc.)
  // Eagerly update scrollOffsetRef so windowing uses the correct offset on the very
  // next render — before the async onScroll callback has a chance to fire.
  const snapToBottom = useCallback(() => {
    atBottomRef.current = true;
    scrollOffsetRef.current = scrollRef.current?.getBottomOffset() ?? scrollOffsetRef.current;
    scrollRef.current?.scrollToBottom();
  }, []);

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
        // Restore the persisted Claude session ID so the next turn resumes
        // the same Claude JSONL conversation rather than starting a new one.
        claudeSessionIdRef.current = resumed.claudeSessionId ?? null;
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
        // Defer snapToBottom until after Yoga has measured the restored messages.
        setTimeout(() => snapToBottom(), 0);
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
  // When bracketed paste fires with no text (image-only clipboard), also check
  // clipboard for an image — Windows Terminal intercepts ctrl+V for paste so the
  // raw key never reaches useInput when the terminal handles it as a paste action.
  useEffect(() => {
    setPasteHandler((text) => {
      if (!text) {
        const img = readImageFromClipboard();
        if (img) {
          setPendingImages((prev) => [...prev, img]);
          addCompleted({ id: makeId("sys"), role: "system", content: `Image attached: ${img.label}` });
          return;
        }
      }
      setPastedContent(text || null);
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

    // Escape: clear paste first; if busy, cancel in-progress request and clear typed-ahead text.
    if (key.escape) {
      if (pastedContentRef.current) {
        setPastedContent(null);
        return;
      }
      if (busyRef.current) {
        composerRef.current?.clearInput();
        abortControllerRef.current?.abort();
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
      // No image on clipboard — tell the user so they know the key reached Rite
      addCompleted({ id: makeId("sys"), role: "system", content: "ctrl+v: no image in clipboard (if this message never appears, your terminal is consuming the key)" });
    }

    // Ctrl+Shift+V — clear pending images
    if (key.ctrl && key.shift && typed === "V") {
      setPendingImages([]);
      return;
    }

    // Autocomplete is active — let Composer's useInput handle up/down navigation;
    // skip scroll so the two handlers don't fight over arrow keys.
    if (autocompleteActiveRef.current) {
      if (key.upArrow || key.downArrow) return;
    }

    // Page up/down — scroll half a page; up/down arrows — scroll 3 lines.
    // Works even while busy so user can read history.
    // Up/down come from both keyboard arrows and mouse wheel (?1007h alternate scroll mode).
    if (key.pageUp || key.upArrow) {
      const ref = scrollRef.current;
      if (ref) {
        const step = key.pageUp ? Math.max(3, Math.floor(msgAreaHeightRef.current / 2)) : 3;
        ref.scrollTo(Math.max(0, ref.getScrollOffset() - step));
      }
      return;
    }
    if (key.pageDown || key.downArrow) {
      const ref = scrollRef.current;
      if (ref) {
        const step = key.pageDown ? Math.max(3, Math.floor(msgAreaHeightRef.current / 2)) : 3;
        ref.scrollTo(Math.min(ref.getBottomOffset(), ref.getScrollOffset() + step));
      }
      return;
    }

    if (busy || showPicker || showApiKeyPrompt) return;

    // ctrl+t: toggle thinking blocks expanded/collapsed
    if (key.ctrl && typed === "t") {
      setThinkingExpanded((v) => !v);
      return;
    }
    // ctrl+o: toggle tool result details expanded/collapsed
    if (key.ctrl && typed === "o") {
      setToolsExpanded((v) => !v);
      return;
    }
  });

  //  submit handler 

  const handleSubmit = useCallback(
    async (value: string) => {
      // Composer already resolved autocomplete and cleared its own state before calling us.
      // value is already trimmed and resolved.
      const typed = value.trim();
      const pasted = pastedContent; // capture before clearing
      const images = pendingImages.slice(); // capture current images
      setPendingImages([]);
      setPastedContent(null);

      // Combine typed text with pasted content; slash commands ignore paste
      let trimmed =
        typed.startsWith("/") || !pasted
          ? typed
          : typed
          ? typed + "\n\n" + pasted
          : pasted;

      if (!trimmed && images.length === 0) return;

      // While busy: queue the message for auto-submission after current task finishes.
      if (busyRef.current) {
        messageQueueRef.current.push(trimmed);
        setQueuedCount(messageQueueRef.current.length);
        return;
      }

      setInputHistory((prev) => (prev.length >= 100 ? [...prev.slice(-99), trimmed] : [...prev, trimmed]));

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
            "  /loop             pick a loop and enter loop mode",
            "  /loop <name>      activate a loop by name",
            "  /loop off         exit loop mode",
            "  /exit             quit",
          ].join("\n"),
        });
        return;
      }

      if (trimmed === "/clear") {
        histRef.current.clear();
        claudeSessionIdRef.current = null;
        const s = sessionRef.current;
        if (s) {
          s.turns = [];
          s.claudeSessionId = undefined;
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

      if (trimmed === "/loop off" || trimmed === "/loop stop") {
        setActiveLoop(null);
        addCompleted({ id: makeId("sys"), role: "system", content: "Loop mode off." });
        return;
      }

      if (trimmed === "/loop") {
        const loops = loadLoops();
        setLoopPickerLoops(loops);
        setShowLoopPicker(true);
        return;
      }

      if (trimmed.startsWith("/loop ")) {
        // /loop <name> — activate by name without picker
        const name = trimmed.slice("/loop ".length).trim();
        if (name === "off" || name === "stop") {
          setActiveLoop(null);
          addCompleted({ id: makeId("sys"), role: "system", content: "Loop mode off." });
          return;
        }
        const loops = loadLoops();
        const found = loops.find((l) => l.name.toLowerCase() === name.toLowerCase());
        if (!found) {
          addCompleted({ id: makeId("sys"), role: "system", content: `Loop not found: "${name}". Use /loop to pick from list.` });
          return;
        }
        setActiveLoop(found);
        addCompleted({
          id: makeId("sys"),
          role: "system",
          content: `Loop mode: ${found.name}${found.description ? `  —  ${found.description}` : ""}\nType your task and each message will run through the loop. Type /loop off to exit.`,
        });
        return;
      }

      if (trimmed.startsWith("/")) {
        // Enter on partial: if exactly one command matches, execute it
        const partialMatches = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(trimmed));
        if (partialMatches.length === 1 && partialMatches[0] !== trimmed) {
          await handleSubmit(partialMatches[0]);
          return;
        }
        addCompleted({
          id: makeId("sys"),
          role: "system",
          content: `Unknown command: ${trimmed}  (type /help for commands)`,
        });
        return;
      }

      //  loop input resolver — mid-loop user prompts bypass normal submit

      if (loopInputResolverRef.current) {
        const resolve = loopInputResolverRef.current;
        loopInputResolverRef.current = null;
        addCompleted({ id: makeId("user"), role: "user", content: trimmed });
        snapToBottom();
        setBusy(true);
        resolve(trimmed);
        return;
      }

      //  loop mode — route message through active loop

      if (activeLoop) {
        setBusy(true);
        snapToBottom();
        addCompleted({ id: makeId("user"), role: "user", content: trimmed });

        const loop = activeLoop;
        const loopAbortController = new AbortController();
        abortControllerRef.current = loopAbortController;
        try {
          await runLoopTui(loop, trimmed, runtimeConfig, {
            onMessage: (text) => {
              addCompleted({ id: makeId("sys"), role: "system", content: text });
              snapToBottom();
            },
            waitForInput: (prompt) => {
              addCompleted({ id: makeId("sys"), role: "system", content: prompt });
              snapToBottom();
              setBusy(false);
              return new Promise<string>((resolve) => {
                loopInputResolverRef.current = resolve;
              });
            },
            onStepStart: (_stepId, stepLabel, stepType) => {
              if (loopTokenAccRef.current.trim()) {
                addCompleted({ id: makeId("asst"), role: "assistant", content: loopTokenAccRef.current });
                snapToBottom();
              }
              stepLabelRef.current = `${stepLabel} (${stepType})`;
              loopTokenAccRef.current = "";
              liveRef.current = "";
            },
            onToken: (text) => {
              loopTokenAccRef.current += text;
              liveRef.current = loopTokenAccRef.current;
            },
          }, loopAbortController.signal);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          addCompleted({ id: makeId("sys"), role: "system", content: `Loop error: ${msg}` });
        } finally {
          abortControllerRef.current = null;
          loopInputResolverRef.current = null;
          if (loopTokenAccRef.current.trim()) {
            addCompleted({ id: makeId("asst"), role: "assistant", content: loopTokenAccRef.current });
            snapToBottom();
          }
          loopTokenAccRef.current = "";
          stepLabelRef.current = "";
          setBusy(false);
          snapToBottom();
        }
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
      activeToolRef.current = null;
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

      // Claude CLI resume: only applicable when using Claude CLI (not images, not other backends).
      // When active, Claude already has the full conversation, so history injection is skipped.
      const shouldResumeClaude =
        assistantBackend === "claude" &&
        images.length === 0 &&
        claudeSessionIdRef.current !== null;

      // When resuming a Claude session, history and always-memories are already in session context.
      // Re-inject semantic hits when they matched the current message — they are per-message relevance
      // matches and may differ from what was relevant on turn 1.
      const enriched = buildEnrichedPrompt(
        trimmed,
        shouldResumeClaude ? [] : alwaysMemories,
        semanticHits,
        histRef.current,
        !shouldResumeClaude,
      );

      // Computed here so the finally block can check willReview without toggling busy.
      const allInjectedMemories = [...alwaysMemories, ...semanticHits];

      let fullResponse = "";
      let cancelled = false;
      let pendingMsg: Message | null = null;
      // Track current thinking block — emitted to completed when the block ends.
      let pendingThinkingText = "";
      // Hold tool calls until we have the result (then emit as one message).
      const pendingToolCalls = new Map<string, { name: string; inputJson: string; startedAt: number }>();
      // Accumulate completed tool calls for the reviewer (so it can treat them as verification evidence).
      const completedToolCalls: string[] = [];
      thinkingRef.current = { chars: 0, text: "" };

      /** Flush the current thinking block to completed and reset live tracking. */
      const flushThinking = () => {
        if (!pendingThinkingText.trim()) return;
        addCompleted({ id: makeId("think"), role: "thinking", content: pendingThinkingText });
        pendingThinkingText = "";
        thinkingRef.current = { chars: 0, text: "" };
      };

      // Shared session-ID handler used by both main and correction turns.
      const handleSessionId = (id: string) => {
        claudeSessionIdRef.current = id;
        const s = sessionRef.current;
        if (s && assistantBackend === "claude") {
          s.claudeSessionId = id;
          saveSession(s);
        }
      };

      try {
        // Refresh the module-level API key on every call so vision works even if
        // the mount-time useEffect fired before config was available.
        const currentKey = runtimeConfig.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
        if (currentKey) setRiteApiKey(currentKey);
        const backendFn = getBackend(assistantBackend);
        fullResponse = await drainAgentStream(
          backendFn(enriched, abortController.signal, images.length > 0 ? images : undefined, {
            resumeSessionId: shouldResumeClaude ? (claudeSessionIdRef.current ?? undefined) : undefined,
          }),
          {
            pendingTools: pendingToolCalls,
            completedToolCalls,
            activeToolRef,
            thinkingRef,
            liveRef,
            onSessionId: handleSessionId,
            onPreText: flushThinking,
            onThinkingDelta(delta) { pendingThinkingText += delta; },
            onToolResult(tool, result, isError) {
              addCompleted({
                id: makeId("tool"),
                role: "tool_call",
                content: tool.name,
                toolName: tool.name,
                toolInputJson: tool.inputJson,
                toolResult: result,
                toolIsError: isError,
                durationMs: Date.now() - tool.startedAt,
              });
            },
          }
        );

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
        activeToolRef.current = null;
        if (pendingMsg) addCompleted(pendingMsg);

        const willReview = !activeLoop && !cancelled && fullResponse.trim() && allInjectedMemories.length > 0;
        if (willReview) {
          stepLabelRef.current = "review (compliance)";
          liveRef.current = "checking response against memory guidelines…";
        } else {
          liveRef.current = "";
          stepLabelRef.current = "";
          abortControllerRef.current = null;
          setBusy(false);
        }
      }

      // Default system loop: silent memory compliance review after every normal response.
      // Runs whenever memories were injected and no named loop is active.
      if (!activeLoop && !cancelled && fullResponse.trim() && allInjectedMemories.length > 0) {
        // busy is already true and loopStepLabel is already set from the finally block above
        let lastResponse = fullResponse;

        for (let attempt = 0; attempt < 3; attempt++) {
          if (abortController.signal.aborted) break;
          let review: { passed: boolean; feedback: string };
          try {
            const responseWithTools = completedToolCalls.length > 0
              ? `${lastResponse}\n\n${TOOL_EVIDENCE_HEADER}\n${completedToolCalls.join("\n")}`
              : lastResponse;
            review = await checkMemoryCompliance(responseWithTools, allInjectedMemories, runtimeConfig, abortController.signal);
          } catch {
            break;
          }

          if (abortController.signal.aborted) break;
          if (review.passed) break;

          // Commit reviewer findings as a permanent chat message so the user can see the assessment.
          addCompleted({
            id: makeId("sys"),
            role: "system",
            content: `→ review (compliance)\n\nPlease revise your previous response to correctly follow these memory guidelines:\n\n${review.feedback}\n\nProvide the corrected response only.`,
          });

          if (attempt === 2) {
            addCompleted({
              id: makeId("sys"),
              role: "system",
              content: `Memory compliance unresolved after 3 attempts.\n\nPersistent issues:\n${review.feedback}`,
            });
            break;
          }

          // Correction turn: injected into history but not shown as a user message.
          stepLabelRef.current = `correction ${attempt + 1} (llm)`;
          liveRef.current = "";
          const correctionMsg = `Please revise your previous response to correctly follow these memory guidelines:\n\n${review.feedback}\n\nProvide the corrected response only.`;
          // Reuse shouldResumeClaude: history and always-memories already in session context.
          // Re-inject semantic hits if relevant to the original message (same hits as main turn).
          const correctionEnriched = buildEnrichedPrompt(
            correctionMsg,
            shouldResumeClaude ? [] : alwaysMemories,
            semanticHits,
            histRef.current,
            !shouldResumeClaude,
          );

          // Reset tool accumulator so the reviewer sees THIS correction turn's evidence, not the original turn's.
          completedToolCalls.length = 0;
          const correctionPendingTools = new Map<string, PendingTool>();
          let correctedResponse = "";
          try {
            correctedResponse = await drainAgentStream(
              getBackend(assistantBackend)(
                correctionEnriched,
                abortController.signal,
                undefined,
                { resumeSessionId: shouldResumeClaude ? (claudeSessionIdRef.current ?? undefined) : undefined }
              ),
              {
                pendingTools: correctionPendingTools,
                completedToolCalls,
                activeToolRef,
                thinkingRef,
                liveRef,
                onSessionId: handleSessionId,
                // No onPreText: correction turns don't commit thinking blocks to completed.
                // No onToolResult: correction tool calls are evidence only, not shown as bubbles.
              }
            );
          } catch {
            break;
          }

          if (!correctedResponse.trim()) break;

          histRef.current.add("user", correctionMsg);
          histRef.current.add("assistant", correctedResponse);
          liveRef.current = "";
          addCompleted({ id: makeId("asst"), role: "assistant", content: correctedResponse });
          lastResponse = correctedResponse;
          stepLabelRef.current = "review (compliance)";
          liveRef.current = "checking corrected response…";
        }

        stepLabelRef.current = "";
        liveRef.current = "";
        abortControllerRef.current = null;
        setBusy(false);
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

  // Stable ref-backed submit — Composer stays memoized even when handleSubmit is recreated
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;
  const onSubmitStable = useCallback((v: string) => { void handleSubmitRef.current(v); }, []);

  const onMetricsChangeStable = useCallback((m: ComposerMetrics) => { setComposerMetrics(m); }, []);

  //  render prep (must be before early returns — hooks can't come after conditional returns)

  const isWorking = busy || embeddingBusy;
  const sessionLabel = activeLoop
    ? `loop:${activeLoop.name}`
    : sessionRef.current
    ? (sessionRef.current.name ?? sessionRef.current.id.slice(0, 10))
    : "";

  // Set terminal tab title when session label changes (OSC 0 = icon name + window title)
  useEffect(() => {
    if (sessionLabel) {
      process.stdout.write(`\x1b]0;${sessionLabel}\x07`);
    }
  }, [sessionLabel]);

  // Compute composer height using metrics emitted by Composer (only when layout changes).
  // Hints box has paddingX={2} → content width = termCols-4.
  // Always use the longest hints text for height estimation so the layout doesn't jump
  // when isWorking flips (Composer renders shorter hints when busy, but we reserve max space).
  const hintsContentWidth = Math.max(20, termCols - 4);
  const hintsLines = Math.ceil(
    "enter send  tab autocomplete  ctrl+p/n history  ctrl+c exit  /help /clear /memory /backend /resume".length /
    hintsContentWidth
  );
  const composerHeight = 1 // status bar
    + 1 // top border
    + composerMetrics.inputLines // input row (grows when text wraps)
    + 1 // bottom border
    + (composerMetrics.hasAutocomplete ? 1 : 0)
    + (pastedContent ? 1 : 0)
    + (pendingImages.length > 0 ? 1 : 0)
    + (queuedCount > 0 ? 1 : 0)
    + hintsLines
    + 1; // safety margin

  // Always reserve 1 line for scroll indicator to prevent layout jump when it shows/hides
  const SCROLL_INDICATOR_HEIGHT = 1;
  // Use termRows-1 so outputHeight < stdout.rows — keeps Ink on the eraseLines
  // path instead of clearTerminal (\x1b[2J), which blanks the screen and flickers.
  const msgAreaHeight = Math.max(3, termRows - composerHeight - SCROLL_INDICATOR_HEIGHT - 1);
  msgAreaHeightRef.current = msgAreaHeight;

  // When msgAreaHeight changes (live area collapses/expands, terminal resize), the
  // viewport grows/shrinks but ink-scroll-view only clamps scroll offset on content-
  // height changes — not on viewport-height changes. A stale offset that exceeds the
  // new getBottomOffset() causes the ↓ handler to jump to 0 (top) instead of bottom,
  // leaving messages at the top with blank space below. Reconcile after every render.
  const prevMsgAreaHeightRef = useRef(0);
  useEffect(() => {
    if (prevMsgAreaHeightRef.current !== 0 && prevMsgAreaHeightRef.current !== msgAreaHeight) {
      setTimeout(() => {
        const ref = scrollRef.current;
        if (!ref) return;
        const bottom = ref.getBottomOffset();
        const current = ref.getScrollOffset();
        if (current > bottom) {
          ref.scrollTo(bottom);
          atBottomRef.current = true;
        }
      }, 0);
    }
    prevMsgAreaHeightRef.current = msgAreaHeight;
  });

  // Logo shown at startup until the first message arrives
  const showLogo = completed.length === 0 && !isWorking;

  // Track scroll position for scroll indicator via onScroll callback
  const [scrolledUp, setScrolledUp] = useState(false);
  const handleScroll = useCallback((offset: number) => {
    scrollOffsetRef.current = offset;
    const bottom = scrollRef.current?.getBottomOffset() ?? 0;
    atBottomRef.current = offset >= bottom;
    setScrolledUp(offset > 0);
    setWindowVersion((v) => v + 1);
  }, []);

  // Auto-scroll to bottom when new content is added, if user was already at bottom.
  // Debounced to 200ms — during streaming the live area height changes many times/second.
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleContentHeightChange = useCallback((_height: number) => {
    if (!atBottomRef.current) return;
    // Eagerly advance scrollOffsetRef so windowing uses the correct window on the
    // next render — before the debounced scrollToBottom fires. Only advance (never
    // retreat): retreating would window out currently-visible messages.
    const ref = scrollRef.current;
    if (ref) {
      const newBottom = ref.getBottomOffset();
      if (newBottom > scrollOffsetRef.current) {
        scrollOffsetRef.current = newBottom;
      }
    }
    if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
    scrollDebounceRef.current = setTimeout(() => {
      const r = scrollRef.current;
      if (r && atBottomRef.current) {
        scrollOffsetRef.current = r.getBottomOffset();
        r.scrollToBottom();
      }
    }, 200);
  }, []);

  //  loop picker overlay

  if (showLoopPicker) {
    return (
      <LoopPicker
        loops={loopPickerLoops}
        onSelect={(loop) => {
          setShowLoopPicker(false);
          setActiveLoop(loop);
          addCompleted({
            id: makeId("sys"),
            role: "system",
            content: `Loop mode: ${loop.name}${loop.description ? `  —  ${loop.description}` : ""}\nType your task and each message will run through the loop. Type /loop off to exit.`,
          });
        }}
        onCancel={() => setShowLoopPicker(false)}
      />
    );
  }

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
          // Restore the Claude session ID so the next turn resumes the right thread.
          claudeSessionIdRef.current = resumed.claudeSessionId ?? null;
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

  return (
    <Box flexDirection="column" height={termRows - 1}>
      {/* Scroll indicator — 1 line reserved always to prevent layout jump */}
      <Box paddingX={1} height={SCROLL_INDICATOR_HEIGHT}>
        {scrolledUp && <Text dimColor>↑ scrolled — pgup/pgdn to navigate</Text>}
      </Box>

      {/* Message area — ink-scroll-view handles true smooth line-level scrolling */}
      <ScrollView
        ref={scrollRef}
        height={showLogo ? Math.max(3, msgAreaHeight - LOGO_HEIGHT) : msgAreaHeight}
        flexDirection="column"
        onScroll={handleScroll}
        onContentHeightChange={handleContentHeightChange}
      >
        {showLogo && <Logo />}
        {(() => {
          const msgs = completed.length > RENDERED_MSG_CAP ? completed.slice(-RENDERED_MSG_CAP) : completed;
          const heights = msgHeightsRef.current;

          const scrollOffset = scrollOffsetRef.current;
          const overscan = msgAreaHeight * 2;
          const windowTop = Math.max(0, scrollOffset - overscan);
          const windowBottom = scrollOffset + msgAreaHeight + overscan;

          let topSpacerH = 0;
          let bottomSpacerH = 0;
          const windowedMsgs: Message[] = [];
          let cumTop = 0;

          for (const msg of msgs) {
            const h = heights.get(msg.id);
            if (h === undefined) {
              // Unmeasured message (newly added) — render it inline so it measures itself.
              // Never spacer an unmeasured message: we don't know its height yet.
              windowedMsgs.push(msg);
              continue;
            }
            if (cumTop + h <= windowTop) {
              topSpacerH += h;
            } else if (cumTop >= windowBottom) {
              bottomSpacerH += h;
            } else {
              windowedMsgs.push(msg);
            }
            cumTop += h;
          }

          return (
            <>
              {topSpacerH > 0 && <Box height={topSpacerH} />}
              {windowedMsgs.map((msg) => (
                <MeasuredBubble key={msg.id} message={msg} thinkingExpanded={thinkingExpanded} toolsExpanded={toolsExpanded} onMeasure={handleMeasure} />
              ))}
              {bottomSpacerH > 0 && <Box height={bottomSpacerH} />}
            </>
          );
        })()}
        {isWorking && <StreamingBubble liveRef={liveRef} activeToolRef={activeToolRef} stepLabelRef={stepLabelRef} thinkingRef={thinkingRef} />}
      </ScrollView>

      {/*  Composer — pinned to bottom; owns input state so keystrokes don't re-render Repl  */}
      <Composer
        ref={composerRef}
        onSubmit={onSubmitStable}
        busy={isWorking}
        backend={assistantBackend}
        utilityBackend={runtimeConfig.utilityBackend}
        memoryCount={alwaysMemories.length}
        memoryIndicator={memoryIndicator}
        session={sessionLabel}
        pendingImageCount={pendingImages.length}
        pastedContent={pastedContent}
        queuedCount={queuedCount}
        inputHistory={inputHistory}
        termCols={termCols}
        autocompleteActiveRef={autocompleteActiveRef}
        onMetricsChange={onMetricsChangeStable}
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
  process.stdout.write("\x1b[?25l"); // hide terminal cursor (TextInput renders its own block cursor)
  process.stdout.write("\x1b[2J\x1b[H"); // clear alt screen, cursor to top-left
  process.stdout.write("\x1b[?1007h"); // alternate scroll mode: wheel → cursor keys, native selection preserved
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
    process.stdout.write("\x1b[?1007l"); // disable alternate scroll mode
    process.stdout.write("\x1b[?25h"); // restore cursor
    process.stdout.write("\x1b[?1049l"); // exit alt screen (restores previous terminal content)
  }
}

