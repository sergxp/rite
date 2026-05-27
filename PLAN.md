# Rite — Implementation Plan

## Context

Rite is a new TypeScript CLI that wraps Claude Code (and Codex) with a persistent memory system and configurable agent loops. The core problem: every LLM CLI session starts from zero. Rite maintains a living knowledge base of project context, user preferences, and behavioral rules — injected automatically into every interaction. Power users define named agent loops (JSON) that automate multi-step workflows with branching, shell commands, and human checkpoints.

---

## Decisions Made

| Topic | Decision |
|---|---|
| Language | TypeScript / Node.js |
| TUI | Ink 5 (React for CLI) |
| Backend | Subprocess: `claude --print` and `codex` |
| v1 backends | Claude and Codex only; extensibility deferred |
| Memory format | Markdown + YAML frontmatter |
| Memory scopes | Global (`~/.rite/memory/`) and project (`.rite/memory/`) |
| Rules | Unified with memory — `type: rule`, `inject: always` |
| Memory extraction | Haiku, fully automatic, non-blocking |
| Memory approval | Auto-save; user prunes via `rite memory delete` |
| Semantic retrieval | `@xenova/transformers` (`all-MiniLM-L6-v2`, local, no API cost) |
| Context management | Summarize-and-compress via Haiku when token budget exceeded |
| Loop condition syntax | LLM-evaluated (`type: condition`, `prompt`, `if_true`, `if_false`) |
| Loop step types | `llm`, `shell`, `human_input`, `condition` |
| Onboarding | Silent — creates `.rite/` in background on first run |
| Team memory | Gitignored by default; user opts in by moving files to `.rite/memory/team/` |
| Distribution | npm as `rite-cli` |

---

## Directory Structure

```
rite/                          ← project root
  package.json
  tsconfig.json
  src/
    index.ts                   ← CLI entry (commander)
    repl/
      index.tsx                ← Ink REPL root component
      history.ts               ← Multi-turn conversation history + summarize-and-compress
      enricher.ts              ← Assemble enriched prompt: memory injection + history
    memory/
      types.ts                 ← MemoryFile schema (YAML frontmatter + body)
      reader.ts                ← Scan + parse memory files from both tiers
      writer.ts                ← Create / update / delete memory files
      search.ts                ← Tag/keyword search + cosine similarity over embeddings
      embeddings.ts            ← transformers.js: embed on write, query-time retrieval
    backends/
      claude.ts                ← execa: `claude --print "<prompt>"`, stream stdout
      codex.ts                 ← execa: `codex` subprocess
    loops/
      types.ts                 ← Loop + Step TypeScript schema
      runner.ts                ← Execute loop: resolve steps, branch, checkpoints
      registry.ts              ← Load loops from ~/.rite/loops/ and .rite/loops/
      steps/
        llm.ts                 ← Call backend with enriched prompt
        shell.ts               ← execa shell command, capture output
        human_input.ts         ← Pause loop, render input prompt in TUI
        condition.ts           ← Haiku call: evaluate prompt → true/false → branch
    extraction/
      extractor.ts             ← Async post-turn Haiku call → parse JSON → write memory
      prompts.ts               ← System prompt for memory extraction
    history/
      compressor.ts            ← Haiku-based summarize-and-compress when token budget hit
    config/
      loader.ts                ← cosmiconfig: ~/.rite/config.json + .rite/config.json
      types.ts                 ← Config schema
    utils/
      frontmatter.ts           ← gray-matter wrapper
      template.ts              ← Mustache: resolve {{memory.always}}, {{steps.x.output}} etc.
      tokens.ts                ← Rough token estimation for budget management

~/.rite/                       ← Global (never committed)
  config.json
  memory/                      ← Global memory files
  loops/                       ← Global loop definitions
  models/                      ← Downloaded transformers.js model weights

.rite/                         ← Per-project (gitignored by default)
  config.json
  memory/
    *.md                       ← Project memories (auto-extracted + user-authored)
    team/                      ← Opt-in: user moves files here to commit to git
    .index/                    ← Embedding cache (always gitignored)
  loops/
    *.json
```

Rite writes a `.gitignore` into `.rite/` on creation:
```
memory/*.md
memory/.index/
!memory/team/
```

---

## Memory File Format

```markdown
---
name: typescript-style
type: rule
tags: [typescript, style, always]
inject: always
priority: high
created: 2026-05-27
updated: 2026-05-27
---

Always use TypeScript strict mode. Prefer `const` over `let`. No `any` types.
```

**Injection tiers:**
- `inject: always` — prepended to every prompt unconditionally (rules, critical project context)
- `inject: semantic` — retrieved by cosine similarity against the current user message
- `inject: never` — stored, accessible only via `{{memory.<name>}}` in loop templates

**Memory types:** `rule`, `project`, `user`, `feedback`, `reference`

---

## Agent Loop JSON Format

```json
{
  "name": "feature-build",
  "description": "Analyze → implement → review → conditional fix or deploy",
  "backend": "claude",
  "steps": [
    {
      "id": "analyze",
      "type": "llm",
      "name": "Architecture Analysis",
      "prompt": "{{memory.always}}\n{{memory.semantic}}\n\nAnalyze the codebase and identify where to implement:\n\n{{context}}"
    },
    {
      "id": "implement",
      "type": "llm",
      "name": "Implementation",
      "prompt": "{{memory.always}}\n\nAnalysis:\n{{steps.analyze.output}}\n\nImplement the feature:\n{{context}}",
      "human_checkpoint": true
    },
    {
      "id": "run_tests",
      "type": "shell",
      "command": "npm test 2>&1 | tail -30"
    },
    {
      "id": "check_tests",
      "type": "condition",
      "prompt": "Do the test results indicate all tests passed with no failures?",
      "if_true": "deploy",
      "if_false": "fix_issues"
    },
    {
      "id": "fix_issues",
      "type": "llm",
      "name": "Fix Failing Tests",
      "prompt": "{{memory.always}}\n\nTest output:\n{{steps.run_tests.output}}\n\nFix the failing tests.",
      "next": "run_tests"
    },
    {
      "id": "deploy",
      "type": "human_input",
      "prompt": "Ready to deploy. Enter deployment target (prod/staging):"
    }
  ]
}
```

**Template variables:** `{{memory.always}}`, `{{memory.semantic}}`, `{{memory.global}}`, `{{memory.project}}`, `{{context}}`, `{{steps.<id>.output}}`

---

## Loop Step Types

| Type | Behavior |
|---|---|
| `llm` | Enrich prompt with memory, call backend subprocess, capture output |
| `shell` | Run command via execa, pipe stdout/stderr as `output` to next step |
| `human_input` | Pause loop, render inline prompt in TUI, user types response → `output` |
| `condition` | Call Haiku with `prompt` + previous context → returns `true`/`false` → branch |

---

## CLI Commands

| Command | Description |
|---|---|
| `rite` | Start interactive REPL |
| `rite loop <name> [--context "..."]` | Run a named agent loop non-interactively |
| `rite loops list` | List all registered loops |
| `rite loops add <file.json>` | Register a loop config |
| `rite memory list [--global\|--project]` | List memory files with type + inject |
| `rite memory add <file.md>` | Add a memory file to project scope |
| `rite memory add --global <file.md>` | Add to global scope |
| `rite memory search "<query>"` | Semantic + keyword search |
| `rite memory edit <name>` | Open in $EDITOR |
| `rite memory delete <name>` | Delete memory file + its embedding cache |
| `rite backend set <claude\|codex>` | Switch default backend |

**REPL slash commands** (typed inline during session):
- `/clear` — reset conversation history
- `/compact` — manually trigger summarize-and-compress
- `/memory` — display active memories for current session
- `/loop <name>` — launch a loop from within the REPL

---

## Key Module Details

### Enricher (`repl/enricher.ts`)
Per turn, assembles the final prompt sent to the backend:
1. Load all `inject: always` memory files from both tiers
2. Embed the user's current message via transformers.js
3. Retrieve top-5 `inject: semantic` memories by cosine similarity
4. Load compressed conversation history (see below)
5. Render via Mustache: `{{memory.always}}` + `{{memory.semantic}}` + history + user message
6. Return enriched string → passed to backend subprocess

### History Compressor (`history/compressor.ts`)
- Track cumulative token estimate (rough: `chars / 4`)
- When history exceeds configurable budget (default: 8000 tokens):
  - Take oldest 50% of turns
  - Call Haiku with compression prompt: "Summarize these conversation turns into a compact context block"
  - Replace the oldest turns with the summary block
- Compression is transparent to the user; REPL continues without interruption

### Background Extractor (`extraction/extractor.ts`)
- Fires async after each REPL turn (non-blocking, no delay to user)
- Sends: system extraction prompt + the completed turn (user message + assistant response)
- Haiku returns JSON array: `[{ action: "create"|"update"|"delete", name, type, tags, inject, body }]`
- Rite applies writes to `.rite/memory/` (project scope by default)
- TUI shows a subtle `◎ memory` indicator when a save occurs

### Loop Condition Step (`loops/steps/condition.ts`)
- Builds prompt: `"Given this context: <previous_output>\n\n<condition_prompt>\n\nRespond with only: true or false"`
- Calls Haiku (cheap, fast, deterministic enough)
- Parses response for `true`/`false` — if neither, defaults to `if_false`
- Routes loop to `if_true` or `if_false` step ID

### Local Embeddings (`memory/embeddings.ts`)
- Model: `Xenova/all-MiniLM-L6-v2` (~22MB, downloaded to `~/.rite/models/` on first use)
- Embedding generation on memory file save → cached to `.rite/memory/.index/<name>.json`
- Query time: embed user message → cosine similarity against all cached vectors → return top-N
- Index entry invalidated if memory file `updated` date is newer than cache timestamp

---

## Tech Stack

| Concern | Library |
|---|---|
| TUI | `ink` v5 + `react` |
| CLI framework | `commander` |
| Subprocess | `execa` |
| LLM SDK (extraction, compression, conditions) | `@anthropic-ai/sdk` |
| Local embeddings | `@xenova/transformers` |
| Frontmatter parsing | `gray-matter` |
| Template resolution | `mustache` |
| Config loading | `cosmiconfig` |
| Dev build | `tsx` |
| Production build | `tsup` |
| Distribution | npm as `rite-cli` |

---

## Implementation Phases

### Phase 1 — Core Shell (MVP)
- Project scaffold: `package.json`, `tsconfig.json`, `tsup` build config
- Config loader (cosmiconfig, two tiers)
- Memory reader: parse markdown + YAML frontmatter, separate `inject: always` from semantic
- Simple enricher: prepend `inject: always` memories to user prompt (no embeddings yet)
- Claude backend: `execa` → `claude --print "<prompt>"`, stream stdout
- Basic Ink REPL: input, streaming output, rolling 20-turn history (before compression added)
- Silent first-run: create `.rite/` + `.gitignore` on startup if absent
- `rite memory list/add/edit/delete` commands

**Deliverable:** `rite` opens a REPL, injects always-on memories, routes to Claude Code.

### Phase 2 — Memory Extraction
- Haiku extractor: async post-turn, JSON response → apply memory writes
- Memory writer: create/update/delete files with proper frontmatter
- TUI `◎ memory` indicator on save
- `rite memory search` (tag/keyword only at this stage)

**Deliverable:** Memory files grow automatically during REPL use.

### Phase 3 — Agent Loops
- Loop JSON schema + TypeScript types
- Loop registry (scan `~/.rite/loops/` and `.rite/loops/`)
- Step runners: `llm`, `shell`, `human_input`, `condition`
- Template engine: Mustache resolution of all `{{...}}` vars
- `rite loop <name>`, `rite loops list/add`

**Deliverable:** `rite loop feature-build --context "add login page"` executes all steps.

### Phase 4 — Semantic Memory + History Compression
- transformers.js integration, model download on first use
- Embedding on memory write, cosine similarity query
- Enricher updated: `inject: semantic` tier active
- History compressor: Haiku-based summarize-and-compress at token budget
- `rite memory search "<query>"` uses embeddings

**Deliverable:** Relevant memories surface automatically; long sessions stay coherent.

---

## Verification

1. **Phase 1**: Run `rite`, type "what is the architecture of this project?", confirm Claude Code responds and output streams. Check `.rite/` was silently created.
2. **Phase 2**: After 5 REPL turns, run `rite memory list` and confirm 1-3 auto-extracted entries exist. Edit one and confirm the next turn sees the change.
3. **Phase 3**: Write a 4-step loop with a condition, run `rite loop test --context "..."`, confirm the condition branches correctly and `human_input` pauses the loop.
4. **Phase 4**: Add 15 semantic memory files, ask a question that should surface 2 of them, run `rite memory search "<same query>"` and confirm the same files rank in top results.
