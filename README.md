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

1. **Extract** — Gemini Flash turns "why did checkout fail around 9:31" into search terms like `checkout`, `CheckoutFailed`.
2. **Retrieve** — those terms are run through `search_logs`; results are deduplicated into one evidence set.
3. **Hypothesize** — Gemini proposes a root cause and cites specific evidence line `id`s it's basing the claim on.
4. **Verify** — a *separate* call, given only the cited lines (not the full evidence set, not the hypothesis-generation context), judges whether those lines actually support the claim. This is the hallucination check: the model that wrote the claim doesn't get to grade its own homework.
5. **Retry once** if the verdict is `not_supported` — regenerate with an explicit "be conservative" instruction, then re-verify.

Uses the free-tier Gemini API rather than a paid one — a deliberate cost tradeoff for a project run repeatedly during development. Model IDs are centralized as `FLASH`/`PRO` constants at the top of `summarize.ts`; **as of testing, pro-tier models return `limit: 0` on this free-tier key** (a hard quota wall, not a temporary rate limit) — currently both constants point at Flash until that's resolved or a paid tier is added. Swapping to another provider entirely is a small, isolated change confined to that one file.

### How the cross-service gap was found and closed

Earlier testing surfaced a real limitation: `summarize_incident` correctly found the *immediate* cause of a checkout failure (DB pool exhaustion) but missed the *upstream* cause the fixture also encodes — a long-running query on a different service holding the connection. Two structural problems, both since fixed:

- **Retrieval was purely lexical.** Extracted terms were checkout-scoped (`checkout`, `failed`, `error`), so `inventory-service` lines could never enter the evidence set no matter how good the reasoning was. Fixed with **time-window expansion**: after the term search, lines within ±120s of the *anomalous* (ERROR/WARN) matches are pulled in regardless of term match, capped at 150 and seeded from anomalies so a wide match span can't drag in the whole file.
- **The verifier could only rubber-stamp.** It was handed *only* the lines the claim cited, which made it structurally incapable of noticing an incomplete answer — a claim that accurately describes a symptom will always look supported by the lines it chose to cite. It now sees the **full** evidence set and scores two independent axes: `soundness` (do the cited lines substantiate the claim?) and `completeness` (does other retrieved evidence point to a cause the claim missed?). A sound-but-incomplete verdict feeds the overlooked line ids back into regeneration, rather than re-prompting against identical evidence as the old retry did.

After the fix, the same query returns the upstream cause — *"...caused by a long-running query (q-88213) in inventory-service holding a database connection for nearly three minutes"* — citing the three lines that entered via expansion. Search terms were unchanged, confirming expansion did the work.

**Honest caveat:** in that run the answer was correct on the first pass, so the completeness axis never had to fire. It's exercised by construction but not yet proven by a failing case — a good target for the eval set.

**Latency tradeoff:** a full pass is now up to 4 sequential LLM calls (~70s observed on the sample log). This exceeds the **60s default request timeout in MCP clients** — raise it when connecting a real client, as `scripts/smoke-test.ts` does.

## Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `GEMINI_API_KEY` | `summarize_incident` | Get one free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). `search_logs` and `get_error_context` work without it. |
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
      "args": ["C:\\Users\\sarve\\OneDrive\\Desktop\\LogLens\\dist\\index.js"],
      "env": {
        "GEMINI_API_KEY": "your-key-here"
      }
    }
  }
}
```

**The `env` block is required, not optional** — MCP clients spawn the server with a sanitized environment by default, not your shell's full environment, so `GEMINI_API_KEY` won't be visible to `summarize_incident` without it even if it's set globally on your machine.

Restart Claude Desktop, then ask it something like *"search the logs for
'pool exhausted'"* — it should call `search_logs` automatically.

### Connect to Claude Code

```bash
claude mcp add loglens --scope user --env GEMINI_API_KEY=your-key-here -- node C:\Users\sarve\OneDrive\Desktop\LogLens\dist\index.js
```

(Same reason as above — `--env` passes the key explicitly since the spawned process doesn't inherit your shell environment by default.)

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
