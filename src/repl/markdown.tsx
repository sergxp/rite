import React from "react";
import { Box, Text } from "ink";
import { highlight } from "cli-highlight";
import { marked } from "marked";

type InlineToken = {
  type: string;
  text?: string;
  raw?: string;
  href?: string;
  title?: string;
  tokens?: InlineToken[];
};

type BlockToken = {
  type: string;
  text?: string;
  raw?: string;
  lang?: string;
  tokens?: Array<InlineToken | BlockToken>;
  items?: Array<{
    text?: string;
    raw?: string;
    tokens?: BlockToken[];
    checked?: boolean;
    task?: boolean;
  }>;
  depth?: number;
  ordered?: boolean;
  start?: number | "";
};

const languageAliases: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  sh: "bash",
  shell: "bash",
  yml: "yaml",
  md: "markdown",
  jsonc: "json",
};

function normalizeLanguage(language?: string): string {
  const cleaned = (language ?? "").trim().toLowerCase();
  return languageAliases[cleaned] ?? cleaned;
}

function inlineNodes(tokens: InlineToken[] | undefined, keyPrefix: string): React.ReactNode[] {
  if (!tokens || tokens.length === 0) {
    return [];
  }

  const nodes: React.ReactNode[] = [];

  tokens.forEach((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.type) {
      case "text":
        if (token.tokens && token.tokens.length > 0) {
          nodes.push(...inlineNodes(token.tokens, key));
        } else {
          nodes.push(token.text ?? token.raw ?? "");
        }
        break;
      case "escape":
        nodes.push(token.text ?? token.raw ?? "");
        break;
      case "codespan":
        nodes.push(
          <Text key={key} color="yellowBright" backgroundColor="black">
            {token.text ?? token.raw ?? ""}
          </Text>
        );
        break;
      case "strong":
        nodes.push(
          <Text key={key} bold>
            {inlineNodes(token.tokens, key)}
          </Text>
        );
        break;
      case "em":
        nodes.push(
          <Text key={key} italic>
            {inlineNodes(token.tokens, key)}
          </Text>
        );
        break;
      case "del":
        nodes.push(
          <Text key={key} strikethrough>
            {inlineNodes(token.tokens, key)}
          </Text>
        );
        break;
      case "link":
        nodes.push(
          <Text key={key} color="cyanBright" underline>
            {inlineNodes(token.tokens, key)}
          </Text>
        );
        break;
      case "image":
        nodes.push(`[${token.text ?? "image"}]`);
        break;
      case "br":
        nodes.push("\n");
        break;
      default:
        if (token.tokens) {
          nodes.push(...inlineNodes(token.tokens, key));
        } else if (typeof token.raw === "string") {
          nodes.push(token.raw);
        }
        break;
    }
  });

  return nodes;
}

function codeLanguageLabel(language?: string): string {
  const normalized = normalizeLanguage(language);
  return normalized ? `▸ ${normalized}` : "▸ code";
}

function CodeBlock({ language, code }: { language?: string; code: string }) {
  const normalized = normalizeLanguage(language);
  let highlighted = code;

  try {
    highlighted = highlight(code, {
      language: normalized || undefined,
      ignoreIllegals: true,
    });
  } catch {
    highlighted = code;
  }

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text color="blueBright" bold>
        {codeLanguageLabel(language)}
      </Text>
      <Box paddingX={1} borderStyle="round" borderColor="blueBright">
        <Text color="whiteBright">{highlighted}</Text>
      </Box>
    </Box>
  );
}

function renderBlocks(tokens: BlockToken[] | undefined, keyPrefix: string): React.ReactNode[] {
  if (!tokens || tokens.length === 0) {
    return [];
  }

  const nodes: React.ReactNode[] = [];

  tokens.forEach((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.type) {
      case "space":
        break;
      case "paragraph":
        nodes.push(
          <Box key={key} marginTop={index === 0 ? 0 : 1}>
            <Text wrap="wrap" color="whiteBright">{inlineNodes(token.tokens as InlineToken[] | undefined, key)}</Text>
          </Box>
        );
        break;
      case "text":
        nodes.push(
          <Box key={key} marginTop={index === 0 ? 0 : 1}>
            <Text wrap="wrap" color="whiteBright">
              {token.tokens && token.tokens.length > 0
                ? inlineNodes(token.tokens as InlineToken[], key)
                : (token.text ?? token.raw ?? "")}
            </Text>
          </Box>
        );
        break;
      case "heading":
        nodes.push(
          <Box key={key} marginTop={index === 0 ? 0 : 1}>
            <Text
              bold
              color={["cyanBright", "greenBright", "yellowBright", "magentaBright", "whiteBright", "whiteBright"][
                Math.min(Math.max(Number(token.depth ?? 1) - 1, 0), 5)
              ]}
            >
              {inlineNodes(token.tokens as InlineToken[] | undefined, key)}
            </Text>
          </Box>
        );
        break;
      case "code":
        nodes.push(<CodeBlock key={key} language={token.lang} code={token.text ?? ""} />);
        break;
      case "blockquote":
        nodes.push(
          <Box key={key} marginTop={1} marginBottom={1}>
            <Text color="blueBright">
              │
            </Text>
            <Box flexDirection="column" paddingLeft={1}>
              {renderBlocks(token.tokens as BlockToken[] | undefined, key)}
            </Box>
          </Box>
        );
        break;
      case "list":
        nodes.push(
          <Box key={key} flexDirection="column" marginTop={1} marginBottom={1}>
            {(token.items ?? []).map((item, itemIndex) => {
              const start = typeof token.start === "number" ? token.start : 1;
              const bullet = token.ordered
                ? `${start + itemIndex}.`
                : item.task
                ? item.checked ? "[x]" : "[ ]"
                : "*";
              return (
                <Box key={`${key}-${itemIndex}`} paddingLeft={1} marginBottom={0}>
                  <Text color="cyanBright" bold>{bullet} </Text>
                  <Box flexDirection="column" flexGrow={1}>
                    {item.tokens && item.tokens.length > 0
                      ? renderBlocks(item.tokens as BlockToken[], `${key}-${itemIndex}`)
                      : <Text wrap="wrap" color="whiteBright">{item.text ?? item.raw ?? ""}</Text>}
                  </Box>
                </Box>
              );
            })}
          </Box>
        );
        break;
      case "hr":
        nodes.push(
          <Box key={key} marginTop={1} marginBottom={1}>
            <Text color="whiteBright">
              {"─".repeat(32)}
            </Text>
          </Box>
        );
        break;
      default:
        nodes.push(
          <Box key={key} marginTop={index === 0 ? 0 : 1}>
            <Text wrap="wrap" color="whiteBright">{token.raw ?? token.text ?? ""}</Text>
          </Box>
        );
        break;
    }
  });

  return nodes;
}

export const MarkdownMessage = React.memo(function MarkdownMessage({ content }: { content: string }) {
  const tokens = React.useMemo(
    () => marked.lexer(content, { gfm: true, breaks: true }) as BlockToken[],
    [content]
  );

  return <Box flexDirection="column">{renderBlocks(tokens, "root")}</Box>;
});
