// Same idea as smoke-test.ts, but against a running HTTP server (e.g. the
// Docker container) instead of spawning the process over stdio. Confirms the
// containerized deployment path actually works end-to-end, not just that it
// answers a health check.
//
//   npx tsx scripts/smoke-test-http.ts http://localhost:3902/mcp
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  const url = process.argv[2] ?? "http://localhost:3000/mcp";
  const transport = new StreamableHTTPClientTransport(new URL(url));

  const client = new Client({ name: "loglens-http-smoke-test", version: "1.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(
    "Registered tools:",
    tools.map((t) => t.name)
  );

  console.log("\n--- summarize_incident('why did checkout fail around 9:31') ---");
  const summary = await client.callTool(
    { name: "summarize_incident", arguments: { query: "why did checkout fail around 9:31" } },
    undefined,
    { timeout: 300_000 }
  );
  console.log(summary.content[0].text);

  await client.close();
}

main().catch((err) => {
  console.error("HTTP smoke test failed:", err);
  process.exit(1);
});
