import React from "react";
import { Box, Text } from "ink";
import { MarkdownMessage } from "./markdown.js";

export type MessageRole = "user" | "assistant" | "system" | "thinking" | "tool_call";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  // tool_call metadata
  toolName?: string;
  durationMs?: number;
}

function ThinkingBubble({ content }: { content: string }) {
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const subject = lines[0] ?? "";
  const body = lines.slice(1);
  const charCount = content.length;

  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Box>
        <Text dimColor italic>💭 thought </Text>
        <Text dimColor>({(charCount / 1000).toFixed(1)}k chars)</Text>
      </Box>
      <Box
        marginLeft={1}
        paddingLeft={1}
        borderStyle="single"
        borderLeft={true}
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderColor="gray"
        flexDirection="column"
      >
        {subject ? (
          <Text italic bold color="gray">{subject}</Text>
        ) : null}
        {body.slice(0, 4).map((line, i) => (
          <Text key={i} italic dimColor color="gray">{line}</Text>
        ))}
        {body.length > 4 && (
          <Text dimColor italic color="gray">…{body.length - 4} more lines</Text>
        )}
      </Box>
    </Box>
  );
}

function ToolCallBubble({ toolName, durationMs }: { toolName: string; durationMs?: number }) {
  const duration = durationMs !== undefined ? ` (${durationMs}ms)` : "";
  return (
    <Box marginBottom={0} paddingLeft={2}>
      <Text dimColor>⚙ </Text>
      <Text color="cyanBright" dimColor>{toolName}</Text>
      <Text dimColor> → ✓{duration}</Text>
    </Box>
  );
}

export function MessageBubble({ message }: { message: Message }) {
  if (message.role === "thinking") {
    return <ThinkingBubble content={message.content} />;
  }

  if (message.role === "tool_call") {
    return <ToolCallBubble toolName={message.toolName ?? message.content} durationMs={message.durationMs} />;
  }

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
