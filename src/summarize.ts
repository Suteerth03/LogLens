import type { SearchMatch } from "./logParser.js";

/**
 * Week 1 stub: no LLM call yet — returns the retrieved evidence in a
 * structured, readable form so the tool is honest and usable end-to-end
 * today, without pretending to do root-cause reasoning it doesn't do yet.
 *
 * Week 2 TODO (the project's actual differentiator):
 *   1. Call an LLM with `query` + the retrieved `matches` as grounding context.
 *   2. Have it produce a root-cause hypothesis.
 *   3. Run a verification pass that re-checks the hypothesis against `matches`
 *      and re-retrieves / flags it if the claim isn't actually supported by
 *      the evidence (the hallucination-check loop from the hackathon project).
 */
export async function summarizeIncident(
  query: string,
  matches: Pick<SearchMatch, "line">[]
): Promise<string> {
  if (matches.length === 0) {
    return `No log evidence found for "${query}". Try a different search term — summarize_incident only reasons over lines search_logs can actually find.`;
  }

  const evidence = matches.map((m, i) => `[${i + 1}] ${m.line}`).join("\n");

  return [
    `Query: ${query}`,
    "",
    `Retrieved ${matches.length} matching line(s):`,
    evidence,
    "",
    "(LLM-based root-cause summarization + verification loop lands in Week 2 — " +
      "see README. For now this tool surfaces the raw grounding evidence only.)",
  ].join("\n");
}
