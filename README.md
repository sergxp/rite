# Rite

A CLI wrapper for AI coding agents (Claude Code, Codex) with persistent memory and configurable agent loops.

Every session with an AI coding agent starts from zero. Rite fixes that. It maintains a living knowledge base about your projects, preferences, and rules — and injects the right context automatically into every interaction. For power users, it also lets you define repeatable multi-step workflows as JSON that orchestrate the underlying agents with branching logic, shell commands, and human checkpoints.

---

## Features

- **Persistent memory** — facts, rules, and preferences stored as markdown files and injected into every prompt
- **Semantic retrieval** — locally-embedded memories (no API cost) surface relevant context per turn using cosine similarity
- **Background memory extraction** — Claude Haiku reads each conversation turn and quietly writes new memories as you work
- **History compression** — long sessions stay coherent; Haiku summarizes old turns when the token budget is reached
- **Agent loops** — define multi-step workflows in JSON with four step types: LLM calls, shell commands, human input, and LLM-evaluated conditionals
- **Two-tier memory** — global memories (`~/.rite/memory/`) apply everywhere; project memories (`.rite/memory/`) are local and gitignored by default

---

## Prerequisites

- Node.js 20+
- [Claude Code](https://claude.ai/code) installed and available as `claude` in your PATH
- An Anthropic API key (for background memory extraction, history compression, and loop conditions)

---

## Installation

```bash
npm install -g rite-cli
```

Or clone and link locally:

```bash
git clone https://github.com/yourname/rite
cd rite
npm install
npm run build
npm link
```

Set your Anthropic API key (used for background memory extraction):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

---

## Quick Start

```bash
# Open the interactive REPL
rite

# Check what memories are loaded
rite memory list

# Add a rule that applies to every session
rite memory add --global my-rule.md

# Run a named agent loop
rite loop feature-build --context "add a login page"
```

---

## Memory System

Memories are plain markdown files with YAML frontmatter. Rite reads them from two locations:

| Tier | Path | Scope |
|---|---|---|
| Global | `~/.rite/memory/*.md` | All projects |
| Project | `.rite/memory/*.md` | Current directory only |

### Memory file format

```markdown
---
name: typescript-style
type: rule
tags: [typescript, style]
inject: always
priority: high
created: 2026-05-27
updated: 2026-05-27
---

Always use TypeScript strict mode. Prefer const over let. No any types.
Use named exports over default exports.
```

### Frontmatter fields

| Field | Values | Description |
|---|---|---|
| `name` | string | Unique identifier (slug-style) |
| `type` | `rule` `project` `user` `feedback` `reference` | Category |
| `tags` | string[] | For search and filtering |
| `inject` | `always` `semantic` `never` | When to inject into prompts |
| `priority` | `high` `normal` `low` | Ordering within a tier |

### Injection modes

- **`always`** — prepended to every prompt unconditionally. Use for hard rules, coding standards, and critical project context.
- **`semantic`** — retrieved per turn by cosine similarity against your message. Use for reference docs, architecture notes, and past decisions. The embedding model runs locally (no API cost); model weights (~22MB) download on first use.
- **`never`** — stored but only accessible via `{{memory.<name>}}` in agent loop templates. Use for large reference files you only want in specific workflows.

### Background extraction

After each REPL turn, Rite fires a non-blocking Haiku call that reads the conversation and decides what's worth remembering. New memories appear in `.rite/memory/` automatically. A `◎ N saved` indicator flashes in the status bar when something was written.

You stay in control: browse with `rite memory list`, edit with `rite memory edit <name>`, remove with `rite memory delete <name>`.

### Team sharing

Project memories are gitignored by default. To share memories with your team, move files into `.rite/memory/team/` — that folder is whitelisted from the gitignore and safe to commit.

### Memory commands

```bash
rite memory list                    # list all memories across both tiers
rite memory list --global           # global only
rite memory list --project          # project only
rite memory add <file.md>           # add to project scope
rite memory add --global <file.md>  # add to global scope
rite memory search "<query>"        # semantic + keyword search
rite memory edit <name>             # open in $EDITOR
rite memory delete <name>           # delete file and its embedding cache
```

---

## Agent Loops

Loops are JSON files that define a sequence of steps for Rite to execute. They let you automate repeatable workflows — feature builds, code reviews, release checklists — with your memory context automatically injected at each step.

### Loop file format

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

### Step types

| Type | What it does |
|---|---|
| `llm` | Calls the active backend (Claude Code) with memory-enriched prompt, streams output |
| `shell` | Runs a shell command, captures stdout+stderr as output for subsequent steps |
| `human_input` | Pauses the loop, prompts the user to type something, uses their response as output |
| `condition` | Asks Haiku a yes/no question about the previous context, branches to `if_true` or `if_false` step |

### Step options

| Option | Description |
|---|---|
| `human_checkpoint: true` | Pause before running this step and ask for confirmation |
| `next: "<step-id>"` | Override sequential flow — jump to a specific step after this one |

### Template variables

Use these in `prompt` and `command` fields:

| Variable | Resolves to |
|---|---|
| `{{memory.always}}` | All `inject: always` memories concatenated |
| `{{memory.semantic}}` | Semantically retrieved memories for current context |
| `{{memory.global}}` | All global-tier memories |
| `{{memory.project}}` | All project-tier memories |
| `{{context}}` | The `--context` string passed when running the loop |
| `{{steps.<id>.output}}` | Output from a previous step by ID |

### Loop commands

```bash
rite loops list                     # list registered loops
rite loops add <file.json>          # register a loop (copies to .rite/loops/)
rite loop <name>                    # run a loop
rite loop <name> --context "..."    # run with initial context
```

Loop files are loaded from `~/.rite/loops/` (global) and `.rite/loops/` (project).

---

## Configuration

Rite merges config from two locations, with project config taking precedence:

| File | Scope |
|---|---|
| `~/.rite/config.json` | Global defaults |
| `.rite/config.json` | Per-project overrides |

### Config options

```json
{
  "backend": "claude",
  "historyLimit": 20,
  "tokenBudget": 8000,
  "anthropicApiKey": ""
}
```

| Option | Default | Description |
|---|---|---|
| `backend` | `claude` | Active backend: `claude` or `codex` |
| `historyLimit` | `20` | Max conversation turns kept in rolling history |
| `tokenBudget` | `8000` | Token estimate threshold that triggers history compression |
| `anthropicApiKey` | `""` | Fallback if `ANTHROPIC_API_KEY` env var is not set |

Switch backend from the CLI:

```bash
rite backend set codex
rite backend set claude
```

---

## REPL

Run `rite` to open the interactive REPL. It presents its own TUI with a status bar, message history, and a live streaming display.

```
┌─ rite | claude | 4 memories ─────────────────────────────┐
```

### Slash commands

Type these directly in the REPL input:

| Command | Description |
|---|---|
| `/clear` | Reset conversation history |
| `/compact` | Manually trigger history summarization |
| `/memory` | Show all currently loaded memories |
| `/loop <name>` | Run a loop from within the REPL |

### Status bar indicators

| Indicator | Meaning |
|---|---|
| `thinking...` | Backend is generating a response |
| `◌ embedding` | Semantic memory retrieval in progress |
| `◎ N saved` | Background memory extraction wrote N new memories |

---

## File Layout

```
~/.rite/                  ← global config and memory (never committed)
  config.json
  memory/*.md
  loops/*.json
  models/                 ← embedding model weights (downloaded on first use)

.rite/                    ← per-project (gitignored by default)
  config.json
  memory/
    *.md                  ← project memories
    team/                 ← opt-in: commit these to share with your team
    .index/               ← embedding cache (always gitignored)
  loops/*.json
```

---

## Tech Stack

| Concern | Library |
|---|---|
| TUI | Ink 5 + React |
| CLI framework | Commander |
| Subprocess | execa |
| LLM SDK | @anthropic-ai/sdk |
| Local embeddings | @xenova/transformers |
| Frontmatter | gray-matter |
| Templates | Mustache |
| Config | cosmiconfig |
| Build | tsup |

---

## Development

```bash
git clone https://github.com/yourname/rite
cd rite
npm install
npm run dev     # watch mode
npm run build   # production build
npm link        # use 'rite' globally from this local build
```

---

## License

MIT
