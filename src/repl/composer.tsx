import React, { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "./text-input.js";
import { useSpinnerFrame, SPINNER_FRAMES } from "./spinner.js";

const SLASH_COMMANDS = [
  "/help", "/clear", "/copy", "/memory", "/resume",
  "/compact", "/apikey", "/exit", "/backend", "/loop", "/loop off",
];

export interface ComposerHandle {
  clearInput(): void;
  setValue(val: string): void;
}

export interface ComposerMetrics {
  inputLines: number;
  hasAutocomplete: boolean;
  hasText: boolean;
}

export interface ComposerProps {
  onSubmit: (val: string) => void;
  busy?: boolean;
  backend?: string;
  utilityBackend?: string;
  memoryCount?: number;
  memoryIndicator?: string | null;
  session?: string;
  pendingImageCount?: number;
  pastedContent?: string | null;
  queuedCount?: number;
  inputHistory?: string[];
  termCols?: number;
  autocompleteActiveRef?: React.MutableRefObject<boolean>;
  onMetricsChange?: (m: ComposerMetrics) => void;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer({
  onSubmit,
  busy = false,
  backend = "claude",
  utilityBackend,
  memoryCount = 0,
  memoryIndicator,
  session,
  pendingImageCount = 0,
  pastedContent,
  queuedCount = 0,
  inputHistory = [],
  termCols = 80,
  autocompleteActiveRef,
  onMetricsChange,
}: ComposerProps, ref) {
  const frame = useSpinnerFrame();

  const [input, setInput] = useState("");
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [autocompleteIdx, setAutocompleteIdx] = useState(0);

  const inputRef = useRef("");
  inputRef.current = input;
  const historyIdxRef = useRef<number | null>(null);
  historyIdxRef.current = historyIdx;
  const draftRef = useRef("");
  draftRef.current = draft;
  const autocompleteIdxRef = useRef(0);
  autocompleteIdxRef.current = autocompleteIdx;
  const inputHistoryRef = useRef(inputHistory);
  inputHistoryRef.current = inputHistory;

  const autocompleteSuggestions =
    input.startsWith("/") && input.length > 1
      ? SLASH_COMMANDS.filter((cmd) => cmd.startsWith(input))
      : [];
  const autocompleteSuggestionsRef = useRef<string[]>([]);
  autocompleteSuggestionsRef.current = autocompleteSuggestions;

  // Keep autocompleteActiveRef in sync so Repl's scroll handler can check it
  if (autocompleteActiveRef) {
    autocompleteActiveRef.current = autocompleteSuggestions.length > 0;
  }

  useImperativeHandle(ref, () => ({
    clearInput() {
      setInput("");
      setHistoryIdx(null);
      setDraft("");
      setAutocompleteIdx(0);
    },
    setValue(val: string) {
      setInput(val);
      setHistoryIdx(null);
      setAutocompleteIdx(0);
    },
  }));

  // Emit metrics when layout-affecting values change so Repl can update msgAreaHeight
  const inputContentWidth = Math.max(10, termCols - 7);
  const inputLines = Math.max(1, Math.ceil((input.length + 1) / inputContentWidth));
  const hasAutocomplete = autocompleteSuggestions.length > 0;
  const hasText = input.trim().length > 0;
  const prevMetricsRef = useRef<ComposerMetrics>({ inputLines: 1, hasAutocomplete: false, hasText: false });
  useEffect(() => {
    const prev = prevMetricsRef.current;
    if (
      prev.inputLines !== inputLines ||
      prev.hasAutocomplete !== hasAutocomplete ||
      prev.hasText !== hasText
    ) {
      const m: ComposerMetrics = { inputLines, hasAutocomplete, hasText };
      prevMetricsRef.current = m;
      onMetricsChange?.(m);
    }
  });

  useInput((typed, key) => {
    // Autocomplete navigation
    if (autocompleteSuggestionsRef.current.length > 0) {
      if (key.upArrow) {
        setAutocompleteIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setAutocompleteIdx((i) =>
          Math.min(autocompleteSuggestionsRef.current.length - 1, i + 1)
        );
        return;
      }
    }

    // History navigation (ctrl+p = previous, ctrl+n = next)
    if (key.ctrl && typed === "p") {
      const hist = inputHistoryRef.current;
      if (!hist.length) return;
      if (historyIdxRef.current === null) {
        setDraft(inputRef.current);
        const idx = hist.length - 1;
        setHistoryIdx(idx);
        setInput(hist[idx] ?? "");
      } else {
        const idx = Math.max(0, historyIdxRef.current - 1);
        setHistoryIdx(idx);
        setInput(hist[idx] ?? "");
      }
      return;
    }
    if (key.ctrl && typed === "n") {
      const hist = inputHistoryRef.current;
      if (historyIdxRef.current === null) return;
      const idx = historyIdxRef.current + 1;
      if (idx >= hist.length) {
        setHistoryIdx(null);
        setInput(draftRef.current);
      } else {
        setHistoryIdx(idx);
        setInput(hist[idx] ?? "");
      }
      return;
    }
  });

  const handleChange = useCallback((val: string) => {
    setInput(val);
    setAutocompleteIdx(0);
    setHistoryIdx(null);
  }, []);

  const handleTab = useCallback(() => {
    const cur = inputRef.current;
    if (!cur.startsWith("/") || cur.length <= 1) return;
    const matches = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(cur));
    if (matches.length === 1) {
      const completion = matches[0].endsWith(" ") ? matches[0] : matches[0] + " ";
      setInput(completion);
      setHistoryIdx(null);
    }
  }, []);

  const handleInternalSubmit = useCallback(
    (val: string) => {
      let trimmed = val.trim();

      // Resolve partial slash commands to the selected autocomplete candidate
      if (trimmed.startsWith("/")) {
        const isExact =
          SLASH_COMMANDS.includes(trimmed) ||
          trimmed.startsWith("/backend ") ||
          trimmed.startsWith("/loop ");
        if (!isExact) {
          const matches = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(trimmed));
          const selected = matches[autocompleteIdxRef.current] ?? matches[0];
          if (selected) trimmed = selected.trim();
        }
      }

      setInput("");
      setHistoryIdx(null);
      setDraft("");
      setAutocompleteIdx(0);
      onSubmit(trimmed);
    },
    [onSubmit]
  );

  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* Status bar */}
      <Box justifyContent="space-between" paddingX={1} marginBottom={0}>
        <Box>
          <Text color="cyanBright" bold>
            Rite
          </Text>
          <Text dimColor> · </Text>
          <Text color="greenBright">{backend}</Text>
          {utilityBackend && utilityBackend !== backend ? (
            <>
              <Text dimColor> / </Text>
              <Text color="yellowBright">
                {utilityBackend}
              </Text>
            </>
          ) : null}
          <Text dimColor> · </Text>
          <Text dimColor>{memoryCount} mem</Text>
        </Box>
        <Box>
          {memoryIndicator ? (
            <Text color="blueBright">{memoryIndicator}</Text>
          ) : (
            <Text dimColor>{session ?? ""}</Text>
          )}
        </Box>
      </Box>

      {/* Input row */}
      <Box
        borderStyle="round"
        borderColor={busy ? "magentaBright" : "cyanBright"}
        paddingX={1}
        flexShrink={0}
      >
        <Text color={busy ? "magentaBright" : "cyanBright"}>
          {busy ? SPINNER_FRAMES[frame] : ">"}
          {" "}
        </Text>
        <TextInput
          value={input}
          onChange={handleChange}
          onSubmit={handleInternalSubmit}
          onTab={handleTab}
          focus={true}
          placeholder={busy ? "Type next message..." : "Ask anything..."}
        />
      </Box>

      {/* Autocomplete suggestions */}
      {autocompleteSuggestions.length > 0 && (
        <Box flexDirection="column" paddingX={1}>
          {autocompleteSuggestions.map((cmd, i) => {
            const isSelected = i === autocompleteIdx;
            return (
              <Box key={cmd}>
                <Text color={isSelected ? "cyan" : "white"} bold={isSelected}>
                  {isSelected ? "> " : "  "}
                  {cmd}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Paste badge */}
      {pastedContent && (
        <Box paddingX={2}>
          <Text color="magentaBright">
            {pastedContent.length} chars · {pastedContent.split("\n").length} lines pasted
          </Text>
          <Text dimColor>  esc to clear</Text>
        </Box>
      )}

      {/* Image attachment indicator */}
      {pendingImageCount > 0 && (
        <Box paddingX={2}>
          <Text color="blueBright">📎 {pendingImageCount} image{pendingImageCount > 1 ? "s" : ""} attached</Text>
          <Text dimColor>  (ctrl+shift+v to remove)</Text>
        </Box>
      )}

      {/* Queue indicator */}
      {queuedCount > 0 && (
        <Box paddingX={2}>
          <Text color="yellowBright">↑ {queuedCount} message{queuedCount > 1 ? "s" : ""} queued</Text>
        </Box>
      )}

      {/* Hints */}
      <Box paddingX={2}>
        <Text dimColor>
          {busy
            ? hasText
              ? "enter queue  esc cancel  ctrl+c exit"
              : "esc cancel  ctrl+c exit"
            : autocompleteSuggestions.length > 0
            ? "enter select  up/down navigate  ctrl+c exit"
            : "enter send  tab autocomplete  ctrl+p/n history  ctrl+c exit  /help /clear /memory /backend /resume"}
        </Text>
      </Box>
    </Box>
  );
});
