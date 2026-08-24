# LogLens

An MCP (Model Context Protocol) server for log analysis. Instead of pasting a
log file into a chat and asking an LLM to debug it, LogLens exposes log
search, context retrieval, and incident summarization as **tools** that any
MCP-compatible client (Claude Desktop, Claude Code, or your own agent) can
call directly — with targeted retrieval instead of context-stuffing, and a
self-verification step to catch unsupported root-cause claims before they're
returned.

## Why this exists

Built as a public, portfolio version of an AI-powered log analyzer that won
1st place at an internal hackathon. Short version of why this beats
paste-into-chat: production logs don't fit in a context window, a chat-paste
isn't callable by other systems, and raw prompting has no mechanism to check
whether the model's answer is actually grounded in the log data.

## Status

- **Core server, 3 tools** — working end-to-end against a sample log. ✅
- **LLM-based root-cause generation** with a hallucination-verification loop
  that checks the hypothesis on two independent axes and retries once if it
  fails either. ✅
- **Mixed-provider architecture** (Groq + Gemini) — the verifier runs on a
  different model family than the generator, so the check doesn't share the
  generator's blind spots. ✅
- **8-case eval suite**, deterministic scoring, 8/8 passing. ✅
- **Dockerized**, runs as a network-reachable HTTP server, verified
  end-to-end against a live container. ✅
- **Deployed on Azure Container Apps.** ✅ Live: https://loglens.livelymushroom-3f0e315d.centralindia.azurecontainerapps.io
- **Next:** a demo GIF.

## Tools

| Tool | What it does |
|---|---|
| `search_logs` | Keyword search over the log file; returns matches with surrounding context and a line `id`. |
| `get_error_context` | Given a line `id`, returns a wider window of lines — full stack traces, sequence of events. |
| `summarize_incident` | Extracts search terms from a natural-language question, retrieves evidence (lexical + time-window + global-anomaly expansion), generates a root-cause hypothesis, then independently verifies it on two axes — retrying once if the verifier rejects it. |

## Architecture

```
Question ──▶ extract search terms (Groq, gpt-oss-20b)
                 │
                 ▼
         search_logs (lexical match)
                 │
                 ▼
    + time-window expansion (asymmetric: 900s before / 180s after —
      causes precede symptoms)
                 │
                 ▼
    + global anomaly scan (all WARN/ERROR lines, not just in-window —
      the explaining line is often itself a warning)
                 │
                 ▼
       generate hypothesis (Groq, gpt-oss-120b)
                 │
                 ▼
    verify: soundness + completeness (Gemini — DIFFERENT provider
    from the generator, on purpose; falls back to same-provider
    Groq if Gemini is unavailable, and reports which happened)
                 │
          unsound/incomplete? ──▶ regenerate once, feeding back
                 │                the lines the first pass overlooked
                 ▼
              answer
```

### Two providers, deliberately — not just a cost workaround

Groq carries extraction and hypothesis generation; Gemini carries
verification. This started as a quota workaround (Gemini's free tier caps at
20 requests/day; Groq's is far more generous) but turned into a real
architectural improvement: **a verifier running on the same model that
produced a claim shares that model's blind spots.** Checking the claim with a
different model family makes the hallucination check genuinely independent,
not just a second opinion from the same source. `Verification.independent`
reports whether a given answer actually got the cross-provider check or fell
back to same-provider (Gemini down/unconfigured) — surfaced, not hidden.

### The cross-service retrieval gap — found via testing, fixed at the right layer

Early testing surfaced a real limitation: `summarize_incident` found the
*immediate* cause of a checkout failure (DB pool exhaustion) but missed the
*upstream* cause the sample log also encodes — a long-running query on a
different service holding the connection. Two structural problems:

- **Retrieval was purely lexical.** Extracted terms were checkout-scoped, so
  `inventory-service` lines could never enter the evidence set no matter how
  good the reasoning was. Fixed with time-window expansion, **asymmetric on
  purpose** (900s before / 180s after) — causes precede symptoms, often by
  more than a short symmetric window would catch — plus a global scan for
  anomalous (WARN/ERROR) lines regardless of window, since the explaining
  line is often itself a warning ("NTP sync failed", "rotation skipped").
- **The verifier could only rubber-stamp.** It originally saw only the lines
  a claim cited, which made it structurally incapable of noticing an
  *incomplete* answer — a claim describing a symptom will always look
  supported by the lines it chose to cite. It now sees the full evidence set
  and scores `soundness` and `completeness` independently; a sound-but-
  incomplete verdict feeds the overlooked lines back into regeneration.

## Eval suite

```bash
npx tsx evals/run-evals.ts          # all 8 cases
npx tsx evals/run-evals.ts 03 08    # a subset, by id substring
```

8 cases spanning distinct failure archetypes: cross-service resource
contention, unbounded-cache OOM, retry-storm amplification, a bad deploy, two
compounding causes, a single-bad-node clock skew, a **healthy log** (correct
answer is "nothing failed"), and a loud-symptom-masking-subtle-cause case
built specifically to exercise the completeness axis. Scoring is
deterministic — concept groups with synonyms, plus required evidence
citations, no LLM judge — so runs are reproducible. The report separates
**retrieval misses** (evidence never reached the model) from **reasoning
misses** (evidence was there, answer still wrong), since those need
different fixes.

**Current result: 8/8 passing, 0 retrieval misses, 0 reasoning misses.**

Debugging this suite is itself a decent engineering story: an asymmetric
time window and a global anomaly scan fixed real retrieval brittleness; on
Groq's free tier, `max_tokens` is a *reservation* against a per-minute token
budget, not a pay-for-what-you-use ceiling — an oversized value gets a 413
regardless of actual prompt size; `reasoning_effort: "low"` was needed on the
gpt-oss models, which otherwise spend the budget on reasoning tokens and
truncate before emitting valid JSON; and the harness itself had two scoring
bugs (Unicode punctuation variants, then a plain-space variant of the same
compound identifier) that reported *correct* answers as failures — worth
knowing when you write your own eval harness: it needs debugging too.

## Docker

```bash
docker build -t loglens:local .
docker run -d -p 3000:3000 \
  -e GROQ_API_KEY=your-key \
  -e GEMINI_API_KEY=your-key \
  loglens:local
curl http://localhost:3000/health
```

Multi-stage build (compile with devDependencies, run with production-only
deps + a non-root user + a container healthcheck on `/health`). The
container runs the HTTP transport (`MCP_TRANSPORT=http`, set by default in
the image) rather than stdio, since a deployed container has no parent
process to spawn it locally the way Claude Desktop/Code do.

**Real bug found and fixed while wiring this up, worth knowing if you build
your own stateless streamable-HTTP MCP server:** the SDK's stateless mode
requires a *fresh transport per request* — reusing one transport across
requests silently 500s every request after the first, with no thrown
exception to catch. Separately, a single `McpServer` can only be connected
to one transport at a time ("Already connected to a transport"). The fix
(see `createServer()` and the HTTP handler in `src/index.ts`) creates both a
fresh `McpServer` and a fresh `StreamableHTTPServerTransport` per request —
cheap, since the server only holds tool *definitions*, no per-connection
state (none of these tools carry state between calls anyway). Verified
against a real running container: `search_logs` and a full `summarize_incident`
pass both completed correctly end-to-end after the fix.

## Deployment

**Live:** https://loglens.livelymushroom-3f0e315d.centralindia.azurecontainerapps.io

Deployed on **Azure Container Apps** (Consumption plan). The image is pushed
to Docker Hub (public — nothing sensitive is baked into it; secrets are
injected at runtime, not build time) rather than Azure Container Registry,
which avoids ACR's ~$5/month Basic-tier cost entirely:

```bash
docker tag loglens:local <dockerhub-user>/loglens:latest
docker push <dockerhub-user>/loglens:latest

az group create --name loglens-rg --location centralindia
az containerapp env create --name loglens-env --resource-group loglens-rg --location centralindia

az containerapp create \
  --name loglens \
  --resource-group loglens-rg \
  --environment loglens-env \
  --image docker.io/<dockerhub-user>/loglens:latest \
  --target-port 3000 \
  --ingress external \
  --min-replicas 0 --max-replicas 1 \
  --cpu 0.25 --memory 0.5Gi \
  --secrets groq-api-key=<key> gemini-api-key=<key> \
  --env-vars GROQ_API_KEY=secretref:groq-api-key GEMINI_API_KEY=secretref:gemini-api-key
```

**`--min-replicas 0` is deliberate, not a default left alone.** Azure's
"Always Free" grant (180K vCPU-seconds + 2M requests/month) is
usage-metered, not time-based — an always-on replica at even the smallest
size (0.25 vCPU) burns through that grant in about 8 days of continuous
uptime, then starts drawing on the temporary $200 trial credit instead of
staying free indefinitely. Scale-to-zero means billing only accrues on
actual requests, which is what keeps a low-traffic demo project genuinely
free long-term rather than free for 30 days. Tradeoff: a request after idle
time takes a few seconds to cold-start a replica.

Verified end-to-end against the live deployment (not just a health check):
tool listing and a real `search_logs` call both returned correct results
through the public URL.

### Access control — public ingress needs it

`--ingress external` means the URL is reachable by anyone on the internet.
Since `summarize_incident` spends the *deployer's* own Groq/Gemini quota on
every call regardless of who's asking — not the caller's — an unauthenticated
public endpoint means anyone who finds the URL can drain that quota (or, for
a busier deployment, run up a bill). The data itself isn't sensitive (a
synthetic sample log), so this is a cost/availability risk, not a privacy
one, but worth closing before sharing the link anywhere public.

Fixed with a shared-secret header check ahead of `transport.handleRequest`:
set `LOGLENS_ACCESS_TOKEN` and every request must carry a matching
`X-LogLens-Token` header, or it's rejected with 401 before it reaches the MCP
layer at all. Unset (the default for local/stdio use), the endpoint stays
open — this only matters once you're exposing it publicly.

```bash
az containerapp secret set --name loglens --resource-group loglens-rg \
  --secrets loglens-access-token=<your-generated-token>
az containerapp update --name loglens --resource-group loglens-rg \
  --set-env-vars LOGLENS_ACCESS_TOKEN=secretref:loglens-access-token
```

Verified against the live deployment: a request without the header now
returns 401; the identical request with `X-LogLens-Token` set returns 200.

## Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `GROQ_API_KEY` | `summarize_incident` (extraction + hypothesis) | Get one free at [console.groq.com/keys](https://console.groq.com/keys). `search_logs` and `get_error_context` work without it. |
| `GEMINI_API_KEY` | independent verification | Get one free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Without it, verification falls back to same-provider (Groq) and is no longer independent — reported via `Verification.independent`, not silently downgraded. |
| `LOGLENS_LOG_FILE` | optional | Point at a real log file instead of the bundled sample. |
| `LOGLENS_ACCESS_TOKEN` | optional, recommended for any public deployment | Requires every `/mcp` request to carry a matching `X-LogLens-Token` header. Unset = open (fine for local/stdio use, not for a public URL). |
| `MCP_TRANSPORT` | optional | `http` runs the network-reachable server (used by Docker); unset/anything else runs stdio (used by Claude Desktop/Code). |
| `PORT` | optional | HTTP port, default `3000`. |

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

### Smoke tests (no MCP client needed)

```bash
npx tsx scripts/smoke-test.ts                              # stdio transport
npx tsx scripts/smoke-test-http.ts http://localhost:3000/mcp  # HTTP transport
```

Spawns (or connects to) the server and calls all three tools — useful for
verifying it works before wiring up a real client. A full `summarize_incident`
pass is 3-4 sequential LLM calls and can take 30-90s; pass a generous
`timeout` if calling it programmatically (both scripts do).

### Connect to Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` (Windows) and add:

```json
{
  "mcpServers": {
    "loglens": {
      "command": "node",
      "args": ["C:\\Users\\sarve\\OneDrive\\Desktop\\LogLens\\dist\\index.js"],
      "env": {
        "GROQ_API_KEY": "your-groq-key",
        "GEMINI_API_KEY": "your-gemini-key"
      }
    }
  }
}
```

**The `env` block is required, not optional** — MCP clients spawn the server with a sanitized environment by default, not your shell's full environment, so the keys won't be visible to `summarize_incident` without it even if set globally on your machine.

Restart Claude Desktop, then ask it something like *"search the logs for
'pool exhausted'"* — it should call `search_logs` automatically.

### Connect to Claude Code

```bash
claude mcp add loglens --scope user --env GROQ_API_KEY=your-groq-key --env GEMINI_API_KEY=your-gemini-key -- node C:\Users\sarve\OneDrive\Desktop\LogLens\dist\index.js
```

(Same reason as above — `--env` passes the keys explicitly since the spawned process doesn't inherit your shell environment by default.)

## Project structure

```
src/
  index.ts       MCP server (dual transport: stdio + HTTP) + tool registration
  logParser.ts   log loading, search, time-window expansion, anomaly scan
  summarize.ts   the summarize_incident pipeline: extract -> retrieve -> hypothesize -> verify -> retry
  providers.ts   Groq + Gemini clients, model config, schema-constrained JSON generation
fixtures/
  sample.log     synthetic incident for local testing
evals/
  cases.ts       8 eval case definitions
  run-evals.ts   deterministic scoring harness
  logs/          synthetic logs for eval cases 02-08
scripts/
  smoke-test.ts       stdio transport smoke test
  smoke-test-http.ts  HTTP transport smoke test
Dockerfile       multi-stage build, non-root user, container healthcheck
```
