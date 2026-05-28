/**
 * Renders messages to ANSI-escaped terminal strings for direct stdout writes.
 * Mirrors the visual style of markdown.tsx / message.tsx but bypasses Ink's
 * layout engine — avoids the Static cursor-tracking bug that clips tall messages.
 */
import { marked } from "marked";
import { highlight } from "cli-highlight";

// ANSI escape helpers
const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";

const GREEN_BRIGHT = "\x1b[92m";
const CYAN_BRIGHT = "\x1b[96m";
const YELLOW_BRIGHT = "\x1b[93m";
const BLUE_BRIGHT = "\x1b[94m";
const WHITE_BRIGHT = "\x1b[97m";
const MAGENTA_BRIGHT = "\x1b[95m";

const INDENT = "   "; // 3 spaces = paddingLeft={3}

const HEADING_COLORS = [
  GREEN_BRIGHT,
  CYAN_BRIGHT,
  YELLOW_BRIGHT,
  MAGENTA_BRIGHT,
  WHITE_BRIGHT,
  WHITE_BRIGHT,
];

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

function normLang(lang?: string): string {
  const c = (lang ?? "").trim().toLowerCase();
  return languageAliases[c] ?? c;
}

// ---- inline renderer ----

type IT = {
  type: string;
  text?: string;
  raw?: string;
  tokens?: IT[];
};

function inl(tokens: IT[] | undefined): string {
  if (!tokens) return "";
  return tokens
    .map((t) => {
      switch (t.type) {
        case "text":
          return t.tokens?.length ? inl(t.tokens) : (t.text ?? "");
        case "escape":
          return t.text ?? "";
        case "codespan":
          return `${YELLOW_BRIGHT}${t.text ?? ""}${R}`;
        case "strong":
          return `${BOLD}${inl(t.tokens)}${R}`;
        case "em":
          return `${ITALIC}${inl(t.tokens)}${R}`;
        case "del":
          return `\x1b[9m${inl(t.tokens)}\x1b[29m`;
        case "link":
          return `${CYAN_BRIGHT}${UNDERLINE}${inl(t.tokens)}${R}`;
        case "image":
          return `[${t.text ?? "image"}]`;
        case "br":
          return "\n";
        default:
          return t.tokens ? inl(t.tokens) : (t.raw ?? "");
      }
    })
    .join("");
}

// ---- block renderer ----

type BT = {
  type: string;
  text?: string;
  raw?: string;
  lang?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | "";
  tokens?: Array<IT | BT>;
  items?: Array<{
    text?: string;
    raw?: string;
    tokens?: BT[];
    checked?: boolean;
    task?: boolean;
  }>;
};

function blk(tokens: BT[], indent = INDENT): string {
  const parts: string[] = [];

  tokens.forEach((t) => {
    switch (t.type) {
      case "space":
        break;

      case "paragraph":
        parts.push(
          `${indent}${WHITE_BRIGHT}${inl(t.tokens as IT[])}${R}`
        );
        break;

      case "text":
        parts.push(
          `${indent}${WHITE_BRIGHT}${
            t.tokens?.length ? inl(t.tokens as IT[]) : (t.text ?? "")
          }${R}`
        );
        break;

      case "heading": {
        const color = HEADING_COLORS[Math.min((t.depth ?? 1) - 1, 5)];
        parts.push(
          `${indent}${BOLD}${color}${inl(t.tokens as IT[])}${R}`
        );
        break;
      }

      case "code": {
        const lang = normLang(t.lang);
        const label = lang ? `* ${lang}` : "* code";
        let body = t.text ?? "";
        try {
          body = highlight(body, {
            language: lang || undefined,
            ignoreIllegals: true,
          });
        } catch {
          /* use raw */
        }
        const codeLines = body
          .split("\n")
          .map((l) => `${indent}  ${l}`)
          .join("\n");
        parts.push(`${indent}${BLUE_BRIGHT}${BOLD}${label}${R}\n${codeLines}`);
        break;
      }

      case "list": {
        const listParts: string[] = [];
        (t.items ?? []).forEach((item, idx) => {
          const start = typeof t.start === "number" ? t.start : 1;
          const bullet = t.ordered
            ? `${start + idx}.`
            : item.task
            ? item.checked
              ? "[x]"
              : "[ ]"
            : "*";

          const innerContent = item.tokens?.length
            ? blk(item.tokens, "")
            : item.text ?? "";

          const lines = innerContent.trim().split("\n");
          const firstLine = `${indent}${CYAN_BRIGHT}${BOLD}${bullet}${R} ${WHITE_BRIGHT}${lines[0] ?? ""}${R}`;
          const restLines = lines
            .slice(1)
            .map((l) => `${indent}  ${l}`)
            .join("\n");
          listParts.push(restLines ? `${firstLine}\n${restLines}` : firstLine);
        });
        parts.push(listParts.join("\n"));
        break;
      }

      case "blockquote": {
        const inner = blk(t.tokens as BT[], "")
          .split("\n")
          .map((l) => `${indent}${BLUE_BRIGHT}|${R} ${l}`)
          .join("\n");
        parts.push(inner);
        break;
      }

      case "hr":
        parts.push(`${indent}${DIM}${"─".repeat(32)}${R}`);
        break;

      default:
        if (t.text ?? t.raw) {
          parts.push(`${indent}${t.text ?? t.raw ?? ""}`);
        }
    }
  });

  return parts.join("\n");
}

// ---- public API ----

export function renderAssistantAnsi(content: string): string {
  const tokens = marked.lexer(content, { gfm: true, breaks: true }) as BT[];
  const body = blk(tokens);
  return `\n ${GREEN_BRIGHT}${BOLD}rite${R}\n${body}\n`;
}

export function renderUserAnsi(content: string): string {
  return `\n ${CYAN_BRIGHT}${BOLD}you${R}\n${INDENT}${WHITE_BRIGHT}${content}${R}\n`;
}

export function renderSystemAnsi(content: string): string {
  return ` ${DIM}${content}${R}\n`;
}
