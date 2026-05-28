import React from "react";
import { Box, Text } from "ink";
import { MarkdownMessage } from "./markdown.js";

export type MessageRole = "user" | "assistant" | "system";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
}

export function MessageBubble({ message }: { message: Message }) {
  if (message.role === "system") {
    return (
      <Box marginBottom={1} paddingLeft={1}>
        <Text color="yellowBright" dimColor> {message.content}</Text>
      </Box>
    );
  }

  if (message.role === "user") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingLeft={1}>
          <Text color="cyanBright" bold>you</Text>
        </Box>
        <Box paddingLeft={3}>
          <Text wrap="wrap" color="whiteBright">{message.content}</Text>
        </Box>
      </Box>
    );
  }

  // assistant
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box paddingLeft={1}>
        <Text color="greenBright" bold>rite</Text>
      </Box>
      <Box paddingLeft={3}>
        <MarkdownMessage content={message.content} />
      </Box>
    </Box>
  );
}
