import React, { useMemo, useState } from "react";
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

const STEP_SEP = "\n\n---\n\n";

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

const TOOL_PREVIEW_LINES = 8;

// Render a preview of tool output, colorizing diff lines. Expandable via `expanded` prop.
function ToolResultPreview({
  result,
  isError,
  expanded,
}: {
  result: string;
  isError: boolean;
  expanded: boolean;
}) {
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
  const visible = expanded ? lines : lines.slice(0, TOOL_PREVIEW_LINES);
  const overflow = !expanded && lines.length > TOOL_PREVIEW_LINES ? lines.length - TOOL_PREVIEW_LINES : 0;

  return (
    <Box flexDirection="column" paddingLeft={4}>
      {visible.map((line, i) => {
        if (hasDiff) {
          if (line.startsWith("+ "))
            return <Text key={i} color="greenBright">{line}</Text>;
          if (line.startsWith("- "))
            return <Text key={i} color="red">{line}</Text>;
        }
        return <Text key={i} dimColor>{line}</Text>;
      })}
      {overflow > 0 && (
        <Text dimColor>… ({overflow} more lines — ctrl+o to expand)</Text>
      )}
    </Box>
  );
}

const THINKING_PREVIEW_LINES = 4;

function ThinkingBubble({ content, expanded }: { content: string; expanded: boolean }) {
  const lines = useMemo(
    () => content.split("\n").map((l) => l.trim()).filter(Boolean),
    [content]
  );

  const subject = lines[0] ?? "";
  const body = lines.slice(1);
  const charCount = content.length;
  const visibleBody = expanded ? body : body.slice(0, THINKING_PREVIEW_LINES);
  const overflow = !expanded && body.length > THINKING_PREVIEW_LINES ? body.length - THINKING_PREVIEW_LINES : 0;
  const marker = expanded ? "▼" : "▶";

  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Box>
        <Text dimColor italic>💭 thought </Text>
        <Text dimColor>({(charCount / 1000).toFixed(1)}k chars) {marker}</Text>
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
          <Text italic bold dimColor>{subject}</Text>
        ) : null}
        {visibleBody.map((line, i) => (
          <Text key={i} italic dimColor>{line}</Text>
        ))}
        {overflow > 0 && (
          <Text italic dimColor>…{overflow} more lines — ctrl+t to expand</Text>
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
  toolsExpanded,
}: {
  toolName: string;
  toolInputJson?: string;
  toolResult?: string;
  toolIsError?: boolean;
  durationMs?: number;
  toolsExpanded: boolean;
}) {
  const detail = toolInputJson ? toolInputSummary(toolName, toolInputJson) : "";
  const isPending = toolResult === undefined;
  const duration = durationMs !== undefined ? ` (${durationMs}ms)` : "";
  const statusColor = isPending ? undefined : toolIsError ? "red" : "cyanBright";
  const statusIcon = isPending ? "…" : toolIsError ? "✗" : "✓";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box paddingLeft={2}>
        <Text dimColor>⚙ </Text>
        <Text color="cyanBright" bold>{toolName}</Text>
        {detail ? <Text dimColor>  {detail}</Text> : null}
        <Text dimColor>  </Text>
        <Text dimColor={isPending} color={statusColor}>{statusIcon}{duration}</Text>
      </Box>
      {toolResult !== undefined && (
        <ToolResultPreview result={toolResult} isError={toolIsError ?? false} expanded={toolsExpanded} />
      )}
    </Box>
  );
}

export const MessageBubble = React.memo(function MessageBubble({
  message,
  thinkingExpanded,
  toolsExpanded,
}: {
  message: Message;
  thinkingExpanded: boolean;
  toolsExpanded: boolean;
}) {
  if (message.role === "thinking") {
    return <ThinkingBubble content={message.content} expanded={thinkingExpanded} />;
  }

  if (message.role === "tool_call") {
    return <ToolCallBubble
      toolName={message.toolName ?? message.content}
      toolInputJson={message.toolInputJson}
      toolResult={message.toolResult}
      toolIsError={message.toolIsError}
      durationMs={message.durationMs}
      toolsExpanded={toolsExpanded}
    />;
  }

  if (message.role === "system") {
    return (
      <Box marginBottom={1} paddingLeft={1}>
        <Text color="yellowBright"> {message.content}</Text>
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
              <Text key={i} color="blueBright">📎 {img.label}  </Text>
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
  const responseParts = useMemo(
    () => message.content.split(STEP_SEP),
    [message.content]
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box paddingLeft={1}>
        <Text color="greenBright" bold>Rite</Text>
      </Box>
      {responseParts.map((part, i) => (
        <Box key={i} paddingLeft={3} marginBottom={i < responseParts.length - 1 ? 1 : 0}>
          <MarkdownMessage content={part.trim()} />
        </Box>
      ))}
    </Box>
  );
});
