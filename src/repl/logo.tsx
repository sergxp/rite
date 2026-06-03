import React from "react";
import { Box, Text } from "ink";

const LINES = [
  " ██████╗ ██╗████████╗███████╗",
  " ██╔══██╗██║╚══██╔══╝██╔════╝",
  " ██████╔╝██║   ██║   █████╗  ",
  " ██╔══██╗██║   ██║   ██╔══╝  ",
  " ██║  ██║██║   ██║   ███████╗",
  " ╚═╝  ╚═╝╚═╝   ╚═╝   ╚══════╝",
];

// Total terminal rows consumed by the Logo component (kept in sync with what renders below).
export const LOGO_HEIGHT = 10; // 1 top pad + 6 text lines + 1 gap + 1 tagline + 1 bottom pad

export function Logo() {
  return (
    <Box flexDirection="column" paddingTop={1} paddingBottom={1} paddingLeft={2}>
      {LINES.map((line, i) => (
        <Text key={i} color={i < LINES.length - 1 ? "cyanBright" : "cyan"} bold={i < LINES.length - 1}>
          {line}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text dimColor>ai pair programmer for the terminal</Text>
      </Box>
    </Box>
  );
}
