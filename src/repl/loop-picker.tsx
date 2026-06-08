import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Loop } from "../loops/types.js";

interface LoopPickerProps {
  loops: Loop[];
  onSelect: (loop: Loop) => void;
  onCancel: () => void;
}

export function LoopPicker({ loops, onSelect, onCancel }: LoopPickerProps) {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(loops.length - 1, c + 1));
    else if (key.return) { if (loops.length > 0) onSelect(loops[cursor]); }
    else if (key.escape || input === "q") onCancel();
  });

  if (loops.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} marginTop={1} borderStyle="single" borderColor="cyan">
        <Box justifyContent="space-between">
          <Text bold color="cyan">Loops</Text>
          <Text dimColor>esc to cancel</Text>
        </Box>
        <Text dimColor>No loops found. Add .json files to ~/.rite/loops/ or .rite/loops/</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1} borderStyle="single" borderColor="cyan">
      <Box justifyContent="space-between">
        <Text bold color="cyan">Loops</Text>
        <Text dimColor>up/down · enter · esc</Text>
      </Box>
      <Box flexDirection="column">
        {loops.map((l, i) => {
          const isSelected = i === cursor;
          const steps = `${l.steps.length} step${l.steps.length !== 1 ? "s" : ""}`;
          const desc = l.description ?? steps;
          return (
            <Box key={l.name} paddingX={1}>
              <Text color={isSelected ? "cyan" : "white"} bold={isSelected}>
                {isSelected ? "> " : "  "}
                {l.name.padEnd(28)}
                {"  "}
                {desc.substring(0, 40)}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
