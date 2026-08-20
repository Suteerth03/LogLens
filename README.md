# LogLens

An MCP (Model Context Protocol) server for log analysis. Instead of pasting a
log file into a chat and asking an LLM to debug it, LogLens exposes log
search, context retrieval, and incident summarization as **tools** that any
MCP-compatible client (Claude Desktop, Claude Code, or your own agent) can
call directly — with targeted retrieval instead of context-stuffing, and
(starting Week 2) a self-verification step to catch unsupported root-cause
claims before they're returned.

## Why this exists

Built as a public, portfolio version of an AI-powered log analyzer that won
1st place at an internal hackathon. See the "why not just paste logs into a
chatbot" writeup in the project history for the full reasoning — short
version: production logs don't fit in a context window, a chat-paste isn't
callable by other systems, and raw prompting has no mechanism to check
whether the model's answer is actually grounded in the log data.

## Status

**Week 1:** core server, 3 tools, working end-to-end against a sample log. ✅
**Week 2 (current):** LLM-based root-cause generation in `summarize_incident`,
plus a hallucination-verification loop that independently checks the
hypothesis against its own cited evidence and retries once if unsupported. ✅
**Week 3 (next):** Docker + Azure deployment, an eval set (accuracy
measurement, not just a demo), polish.

## Tools

| Tool | What it does |
|---|---|
| `search_logs` | Keyword search over the log file; returns matches with surrounding context and a line `id`. |
| `get_error_context` | Given a line `id`, returns a wider window of lines — full stack traces, sequence of events. |
| `summarize_incident` | Extracts search terms from a natural-language question (Haiku), retrieves evidence, generates a root-cause hypothesis (Opus), then independently verifies the hypothesis against its own cited evidence — retrying once if the verifier rejects it as unsupported. |

### The verification loop, concretely

1. **Extract** — Haiku turns "why did checkout fail around 9:31" into search terms like `pool exhausted`, `Timeout acquiring db connection`.
2. **Retrieve** — those terms are run through `search_logs`; results are deduplicated into one evidence set.
3. **Hypothesize** — Opus proposes a root cause and cites specific evidence line `id`s it's basing the claim on.
4. **Verify** — a *separate* Opus call, given only the cited lines (not the full evidence set, not the hypothesis-generation context), judges whether those lines actually support the claim. This is the hallucination check: the model that wrote the claim doesn't get to grade its own homework.
5. **Retry once** if the verdict is `not_supported` — regenerate with an explicit "be conservative" instruction, then re-verify.

## Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `summarize_incident` | Get one at [console.anthropic.com](https://console.anthropic.com). `search_logs` and `get_error_context` work without it. |
| `LOGLENS_LOG_FILE` | optional | Point at a real log file instead of the bundled sample. |

## Setup

```bash
npm install
npm run build
```

By default the server reads `fixtures/sample.log`, a synthetic incident
(a long-running unindexed query on `inventory-service` exhausts a shared DB
connection pool, cascading into `checkout-service` failures). Point it at a
real log file instead with:

```bash
LOGLENS_LOG_FILE=/path/to/real.log node dist/index.js
```

### Smoke test (no MCP client needed)

```bash
npx tsx scripts/smoke-test.ts
```

Spawns the built server over stdio and calls all three tools once — useful
for verifying the server works before wiring up a real client.

### Connect to Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` (Windows) and add:

```json
{
  "mcpServers": {
    "loglens": {
      "command": "node",
      "args": ["C:\\Users\\sarve\\OneDrive\\Desktop\\LogLens\\dist\\index.js"]
    }
  }
}
```

Restart Claude Desktop, then ask it something like *"search the logs for
'pool exhausted'"* — it should call `search_logs` automatically.

### Connect to Claude Code

```bash
claude mcp add loglens -- node C:\Users\sarve\OneDrive\Desktop\LogLens\dist\index.js
```

## Project structure

```
src/
  index.ts       MCP server + tool registration
  logParser.ts   log loading, search, context windowing
  summarize.ts   incident summarization (LLM step lands Week 2)
fixtures/
  sample.log     synthetic incident for local testing
scripts/
  smoke-test.ts  spawns the server and calls each tool once
```
