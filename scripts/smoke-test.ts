// Standalone smoke test: spawns our own built server over stdio and calls
// each tool once, so we can verify the whole pipe works before wiring up a
// real MCP client like Claude Desktop/Code.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    // StdioClientTransport spawns the server with a sanitized default
    // environment, not a full inherited one — without this, GEMINI_API_KEY
    // (and LOGLENS_LOG_FILE) never reach the child process even if set here.
    env: process.env as Record<string, string>,
  });

  const client = new Client({ name: "loglens-smoke-test", version: "1.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(
    "Registered tools:",
    tools.map((t) => t.name)
  );

  console.log("\n--- search_logs('pool exhausted') ---");
  const search = await client.callTool({
    name: "search_logs",
    arguments: { query: "pool exhausted", contextSize: 1 },
  });
  console.log(search.content[0].text);

  console.log("\n--- get_error_context(lineId=13) ---");
  const context = await client.callTool({
    name: "get_error_context",
    arguments: { lineId: 13, contextSize: 3 },
  });
  console.log(context.content[0].text);

  console.log("\n--- summarize_incident('why did checkout fail around 9:31') ---");
  try {
    // Generous timeout: the pipeline makes up to 4 sequential LLM calls
    // (generate -> verify -> regenerate -> re-verify), which overruns the
    // MCP client's 60s default. Real clients need the same allowance.
    const started = Date.now();
    const summary = await client.callTool(
      {
        name: "summarize_incident",
        arguments: { query: "why did checkout fail around 9:31" },
      },
      undefined,
      { timeout: 300_000 }
    );
    console.log(summary.content[0].text);
    console.log(`\n(took ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    console.log(
      "summarize_incident failed — this step calls the Gemini API and needs GEMINI_API_KEY set.\n" +
        `(${(err as Error).message})`
    );
  }

  await client.close();
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
