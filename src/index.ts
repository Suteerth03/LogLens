#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
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
      `Verification — soundness: ${v.soundness}, completeness: ${v.completeness}`,
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`LogLens MCP server running on stdio (log file: ${LOG_FILE})`);
}

main().catch((err) => {
  console.error("Fatal error starting LogLens:", err);
  process.exit(1);
});
