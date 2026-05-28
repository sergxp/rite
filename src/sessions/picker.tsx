import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Session } from "./types.js";

interface SessionPickerProps {
  sessions: Session[];
  onSelect: (session: Session) => void;
  onCancel: () => void;
}

export function SessionPicker({ sessions, onSelect, onCancel }: SessionPickerProps) {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow) {
      setCursor((c) => Math.min(sessions.length - 1, c + 1));
    } else if (key.return) {
      if (sessions.length > 0) onSelect(sessions[cursor]);
    } else if (key.escape || input === "q") {
      onCancel();
    }
  });

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} marginTop={1} borderStyle="single" borderColor="yellow">
        <Box justifyContent="space-between">
          <Text bold color="cyan">
            Sessions
          </Text>
          <Text color="gray" dimColor>
            esc
          </Text>
        </Box>
        <Text color="gray">No Sessions Found.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1} borderStyle="single" borderColor="yellow">
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          Sessions
        </Text>
        <Text color="gray" dimColor>
          up/down | enter | esc
        </Text>
      </Box>
      <Box flexDirection="column">
        {sessions.map((s, i) => {
          const label = (s.name ?? s.id).padEnd(24);
          const typeLabel =
            s.type === "loop"
              ? `loop:${(s.loopName ?? "?").substring(0, 10)}`
              : "repl";
          const date = new Date(s.createdAt).toLocaleDateString();
          const count = `${s.turns.length} turn${s.turns.length !== 1 ? "s" : ""}`;
          const isSelected = i === cursor;
          return (
            <Box key={s.id} paddingX={1}>
              <Text color={isSelected ? "cyan" : "white"} bold={isSelected}>
                {isSelected ? "> " : "  "}
                {label}
                {"  "}
                {typeLabel.padEnd(14)}
                {"  "}
                {date.padEnd(12)}
                {"  "}
                {count}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
