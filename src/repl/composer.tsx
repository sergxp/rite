import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

const SPINNER = ["|", "/", "-", "\\", "|", "/", "-", "\\", "|", "/"];

export interface ComposerProps {
  value: string;
  onChange: (val: string) => void;
  onSubmit: (val: string) => void;
  busy?: boolean;
  backend?: string;
  utilityBackend?: string;
  memoryCount?: number;
  memoryIndicator?: string | null;
  session?: string;
  pendingImageCount?: number;
  pastedContent?: string | null;
  onClearPaste?: () => void;
  queuedCount?: number;
}

export function Composer({
  value,
  onChange,
  onSubmit,
  busy = false,
  backend = "claude",
  utilityBackend,
  memoryCount = 0,
  memoryIndicator,
  session,
  pendingImageCount = 0,
  pastedContent,
  onClearPaste: _onClearPaste,
  queuedCount = 0,
}: ComposerProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!busy) {
      setFrame(0);
      return;
    }
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(t);
  }, [busy]);

  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* Status bar */}
      <Box justifyContent="space-between" paddingX={1} marginBottom={0}>
        <Box>
          <Text color="cyan" bold>
            rite
          </Text>
          <Text dimColor> · </Text>
          <Text color="greenBright">{backend}</Text>
          {utilityBackend && utilityBackend !== backend ? (
            <>
              <Text dimColor> / </Text>
              <Text color="yellowBright" dimColor>
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
          {busy ? SPINNER[frame] : ">"}
          {" "}
        </Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus={true}
          placeholder={busy ? "Type next message..." : "Ask anything..."}
        />
      </Box>

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
            ? value.trim()
              ? "enter/esc queue  ctrl+c exit"
              : "esc cancel  ctrl+c exit"
            : "enter send  up/down history  ctrl+c exit  /help /clear /memory /backend /resume"}
        </Text>
      </Box>
    </Box>
  );
}
