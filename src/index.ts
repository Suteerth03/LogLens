#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLog, searchLogs, getContext, type LogLine } from "./logParser.js";
import { summarizeIncident } from "./summarize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// LOGLENS_LOG_FILE lets you point this at a real log file; defaults to the
// bundled sample so the server is usable out of the box.
const LOG_FILE = process.env.LOGLENS_LOG_FILE
  ? path.resolve(process.env.LOGLENS_LOG_FILE)
  : path.join(__dirname, "..", "fixtures", "sample.log");

function readLogLines(): LogLine[] {
  const raw = fs.readFileSync(LOG_FILE, "utf-8");
  return loadLog(raw);
}

/**
 * Factory, not a module-level singleton — an `McpServer` can only be
 * `.connect()`ed to ONE transport at a time ("Already connected to a
 * transport" if you try a second). Stdio mode connects once and lives for
 * the process lifetime, so a singleton would be fine there; HTTP mode needs
 * a fresh transport per request (see main()), which means a fresh server per
 * request too. Cheap to create — this only registers tool definitions, no
 * state carries between calls regardless.
 */
function createServer(): McpServer {
  const server = new McpServer({ name: "loglens", version: "1.0.0" });

  server.registerTool(
    "search_logs",
    {
      title: "Search Logs",
      description:
        "Search the loaded log file for lines matching a keyword or phrase. Returns matching lines with " +
        "surrounding context and a line id you can pass to get_error_context for a wider view.",
      inputSchema: {
        query: z.string().describe("Keyword or phrase to search for, e.g. 'OutOfMemoryError' or 'timeout'"),
        contextSize: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe("Lines of context before/after each match (default 2)"),
        caseSensitive: z.boolean().optional().describe("Case-sensitive search (default false)"),
      },
    },
    async ({ query, contextSize, caseSensitive }) => {
      const matches = searchLogs(readLogLines(), query, { contextSize, caseSensitive });
      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No matches found for "${query}".` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
    }
  );

  server.registerTool(
    "get_error_context",
    {
      title: "Get Error Context",
      description:
        "Given a line id (from search_logs), return a wider window of surrounding log lines — useful for " +
        "viewing a full stack trace or the sequence of events around a failure.",
      inputSchema: {
        lineId: z.number().int().min(0).describe("The line id returned by search_logs"),
        contextSize: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Lines before/after to include (default 5)"),
      },
    },
    async ({ lineId, contextSize }) => {
      const context = getContext(readLogLines(), lineId, contextSize);
      if (!context) {
        return { content: [{ type: "text", text: `No line found with id ${lineId}.` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(context, null, 2) }] };
    }
  );

  server.registerTool(
    "summarize_incident",
    {
      title: "Summarize Incident",
      description:
        "Investigate a natural-language question about the logs: extracts search terms, retrieves " +
        "grounding evidence (lexical matches plus lines from the same time window, which surfaces " +
        "cross-service causes the question never named), generates a root-cause hypothesis, then " +
        "verifies it on two axes — whether the cited lines support it, and whether it accounts for " +
        "everything the evidence shows — regenerating once if it is unsound or incomplete.",
      inputSchema: {
        query: z.string().describe("What you're investigating, e.g. 'why did checkout fail around 9:31'"),
      },
    },
    async ({ query }) => {
      const result = await summarizeIncident(query, readLogLines());

      if ("error" in result) {
        return { content: [{ type: "text", text: result.error }] };
      }

      const { verification: v, evidenceCount: n } = result;
      const text = [
        `Root cause (${result.confidence} confidence): ${result.rootCause}`,
        "",
        `Verification — soundness: ${v.soundness}, completeness: ${v.completeness} ` +
          `(checked by ${v.verifierModel}${v.independent ? ", independent of the generator" : ", SAME provider as generator — weaker check"})`,
        v.explanation,
        result.retried
          ? "(Regenerated once: the first hypothesis was rejected as unsound or incomplete.)"
          : "",
        "",
        "Cited evidence:",
        ...result.citedEvidence.map((e) => `  [${e.id}] ${e.line}`),
        "",
        `Search terms used: ${result.searchTermsUsed.join(", ")}`,
        `Evidence retrieved: ${n.fromSearch} by term match, ${n.fromExpansion} by time-window expansion`,
      ]
        .filter((l) => l !== "")
        .join("\n");

      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}

/**
 * stdio (default): what Claude Desktop/Code use, spawning this as a local
 * child process. HTTP (MCP_TRANSPORT=http): a network-reachable server for
 * a deployed container — nothing to spawn, clients connect to a URL.
 *
 * Stateless HTTP (sessionIdGenerator: undefined) is deliberate, not a
 * shortcut: every tool call already re-reads the log file fresh
 * (readLogLines() has no cache), so there's no per-session state to lose by
 * not tracking sessions, and it means any request can hit any container
 * replica — no sticky sessions needed to scale this out. But stateless mode
 * has a real requirement that cost real debugging time to find: the SDK
 * rejects a second request against the same transport instance
 * ("each request must use a fresh transport" — silently 500s otherwise,
 * no thrown error), and separately a single McpServer can only be connected
 * to one transport at a time ("Already connected to a transport"). So both
 * the transport AND the server are created fresh per request below.
 */
async function main() {
  if (process.env.MCP_TRANSPORT === "http") {
    const port = Number(process.env.PORT) || 3000;
    const httpServer = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.url !== "/mcp") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found — POST to /mcp" }));
        return;
      }
      // With `--ingress external` the /mcp endpoint is reachable by anyone
      // on the internet with the URL. Since summarize_incident spends the
      // deployer's own Groq/Gemini quota on every call regardless of who's
      // asking, an unauthenticated public endpoint means anyone who finds
      // the URL can drain that quota. LOGLENS_ACCESS_TOKEN gates it with a
      // shared secret; unset (local/dev use) leaves it open, matching prior
      // behavior for stdio and local HTTP testing.
      const accessToken = process.env.LOGLENS_ACCESS_TOKEN;
      if (accessToken && req.headers["x-loglens-token"] !== accessToken) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized — missing or incorrect X-LogLens-Token header" }));
        return;
      }
      try {
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        console.error("Error handling MCP request:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      }
    });

    httpServer.listen(port, () => {
      console.error(`LogLens MCP server listening on http://0.0.0.0:${port}/mcp (log file: ${LOG_FILE})`);
    });
  } else {
    const transport = new StdioServerTransport();
    await createServer().connect(transport);
    console.error(`LogLens MCP server running on stdio (log file: ${LOG_FILE})`);
  }
}

// Surfaces anything swallowed inside the SDK's internal request handling
// (e.g. the hono/node-server adapter used by StreamableHTTPServerTransport)
// that wouldn't otherwise reach the per-request try/catch in main().
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

main().catch((err) => {
  console.error("Fatal error starting LogLens:", err);
  process.exit(1);
});
