import React from "react";
import { Box, Text } from "ink";
import { MarkdownMessage } from "./markdown.js";
import type { ImageAttachment } from "../backends/events.js";

export type MessageRole = "user" | "assistant" | "system" | "thinking" | "tool_call";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  images?: ImageAttachment[];
  // tool_call metadata
  toolName?: string;
  toolInputJson?: string;
  toolResult?: string;
  toolIsError?: boolean;
  durationMs?: number;
}

// Extract a concise description from tool input JSON (filename, command, pattern, etc.)
function toolInputSummary(toolName: string, inputJson: string): string {
  try {
    const input = JSON.parse(inputJson) as Record<string, unknown>;
    // Prefer the most meaningful single field per tool type
    if (typeof input.command === "string") {
      const cmd = input.command.replace(/\s+/g, " ").trim();
      return cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd;
    }
    if (typeof input.file_path === "string") return input.file_path;
    if (typeof input.path === "string") return input.path;
    if (typeof input.pattern === "string") {
      const suffix = typeof input.path === "string" ? ` in ${input.path}` : "";
      return `${input.pattern}${suffix}`;
    }
    if (typeof input.query === "string") return input.query;
    return "";
  } catch {
    return "";
  }
}

// Render a 3-line preview of tool output, colorizing diff lines like open-claudecode.
function ToolResultPreview({ result, isError }: { result: string; isError: boolean }) {
  if (isError) {
    const preview = result.slice(0, 200).replace(/\n/g, " ");
    return (
      <Box paddingLeft={4}>
        <Text color="red">✗ {preview}</Text>
      </Box>
    );
  }

  const lines = result.split("\n").filter((l) => l.trim());
  const hasDiff =
    lines.some((l) => l.startsWith("- ")) && lines.some((l) => l.startsWith("+ "));
  const preview = lines.slice(0, 4);
  const overflow = lines.length > 4 ? lines.length - 4 : 0;

  return (
    <Box flexDirection="column" paddingLeft={4}>
      {preview.map((line, i) => {
        if (hasDiff) {
          if (line.startsWith("+ "))
            return <Text key={i} color="green" dimColor>{line}</Text>;
          if (line.startsWith("- "))
            return <Text key={i} color="red" dimColor>{line}</Text>;
        }
        return <Text key={i} dimColor>{line}</Text>;
      })}
      {overflow > 0 && (
        <Text dimColor>… ({overflow} more lines)</Text>
      )}
    </Box>
  );
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

function ToolCallBubble({
  toolName,
  toolInputJson,
  toolResult,
  toolIsError,
  durationMs,
}: {
  toolName: string;
  toolInputJson?: string;
  toolResult?: string;
  toolIsError?: boolean;
  durationMs?: number;
}) {
  const detail = toolInputJson ? toolInputSummary(toolName, toolInputJson) : "";
  const isPending = toolResult === undefined;
  const duration = durationMs !== undefined ? ` (${durationMs}ms)` : "";
  const statusColor = isPending ? "gray" : toolIsError ? "red" : "cyan";
  const statusIcon = isPending ? "…" : toolIsError ? "✗" : "✓";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box paddingLeft={2}>
        <Text dimColor>⚙ </Text>
        <Text color="cyanBright" bold dimColor>{toolName}</Text>
        {detail ? <Text dimColor>  {detail}</Text> : null}
        <Text dimColor>  </Text>
        <Text color={statusColor} dimColor>{statusIcon}{duration}</Text>
      </Box>
      {toolResult !== undefined && (
        <ToolResultPreview result={toolResult} isError={toolIsError ?? false} />
      )}
    </Box>
  );
}

export function MessageBubble({ message }: { message: Message }) {
  if (message.role === "thinking") {
    return <ThinkingBubble content={message.content} />;
  }

  if (message.role === "tool_call") {
    return <ToolCallBubble
      toolName={message.toolName ?? message.content}
      toolInputJson={message.toolInputJson}
      toolResult={message.toolResult}
      toolIsError={message.toolIsError}
      durationMs={message.durationMs}
    />;
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
        {message.images && message.images.length > 0 && (
          <Box paddingLeft={3}>
            {message.images.map((img, i) => (
              <Text key={i} color="blueBright" dimColor>📎 {img.label}  </Text>
            ))}
          </Box>
        )}
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
