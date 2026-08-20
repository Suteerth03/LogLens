import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { SearchMatch } from "./logParser.js";

// Mixed-model strategy: Haiku for the cheap keyword-extraction step, Opus for
// the two steps where reasoning quality actually matters (root-cause
// generation and the hallucination-check verification pass).
const HAIKU = "claude-haiku-4-5";
const OPUS = "claude-opus-5";

const client = new Anthropic();

const SearchTermsSchema = z.object({
  terms: z
    .array(z.string())
    .min(1)
    .max(5)
    .describe(
      "Short keywords/phrases likely to appear verbatim in log lines related to the question " +
        "(error names, service names, identifiers) — not a paraphrase of the question itself."
    ),
});

const HypothesisSchema = z.object({
  rootCause: z.string().describe("A concise root-cause explanation, one to three sentences."),
  confidence: z.enum(["high", "medium", "low"]),
  citedLineIds: z
    .array(z.number().int())
    .describe("The 'id' values of the specific evidence lines this hypothesis is based on."),
});

const VerificationSchema = z.object({
  verdict: z.enum(["supported", "partially_supported", "not_supported"]),
  explanation: z.string().describe("Why the cited lines do or do not support the root-cause claim."),
});

export interface IncidentEvidence {
  id: number;
  line: string;
}

/**
 * Step 1: turn a natural-language question into search terms likely to
 * appear verbatim in log lines, instead of substring-matching the raw
 * question (the Week 1 limitation noted in the README).
 */
async function extractSearchTerms(query: string): Promise<string[]> {
  const response = await client.messages.parse({
    model: HAIKU,
    max_tokens: 1024,
    system:
      "You turn a natural-language incident question into short search keywords that would " +
      "literally appear in application log lines. Prefer terms likely to appear verbatim " +
      "(error class names, service names, identifiers) over paraphrases of the question.",
    messages: [{ role: "user", content: query }],
    output_config: { format: zodOutputFormat(SearchTermsSchema) },
  });
  return response.parsed_output?.terms ?? [query];
}

/** Step 2: generate a root-cause hypothesis grounded only in retrieved evidence. */
async function generateHypothesis(
  query: string,
  evidence: IncidentEvidence[]
): Promise<z.infer<typeof HypothesisSchema> | null> {
  const evidenceText = evidence.map((e) => `[id=${e.id}] ${e.line}`).join("\n");
  const response = await client.messages.parse({
    model: OPUS,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system:
      "You are a root-cause analysis assistant for application logs. You are given a question " +
      "and a set of retrieved log lines, each tagged with an id. Base your root-cause hypothesis " +
      "ONLY on these lines — do not invent services, errors, or events not present in the evidence. " +
      "Cite the specific line ids that support your conclusion.",
    messages: [{ role: "user", content: `Question: ${query}\n\nRetrieved log evidence:\n${evidenceText}` }],
    output_config: { format: zodOutputFormat(HypothesisSchema) },
  });
  return response.parsed_output;
}

/**
 * Step 3 — the hallucination-check loop: independently judge whether the
 * *cited* lines actually support the claim, rather than trusting the model
 * that generated the claim to grade its own homework.
 */
async function verifyHypothesis(
  hypothesis: z.infer<typeof HypothesisSchema>,
  citedEvidence: IncidentEvidence[]
): Promise<z.infer<typeof VerificationSchema>> {
  const evidenceText =
    citedEvidence.map((e) => `[id=${e.id}] ${e.line}`).join("\n") ||
    "(none — the hypothesis cited no line ids that exist in the retrieved evidence)";
  const response = await client.messages.parse({
    model: OPUS,
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    system:
      "You are a strict fact-checker. Given a root-cause claim and ONLY the specific log lines it " +
      "cites as support, judge whether those lines actually substantiate the claim. Be skeptical: " +
      "a plausible-sounding claim not directly backed by the cited lines is 'not_supported' or " +
      "'partially_supported', never 'supported'.",
    messages: [{ role: "user", content: `Claim: ${hypothesis.rootCause}\n\nCited evidence:\n${evidenceText}` }],
    output_config: { format: zodOutputFormat(VerificationSchema) },
  });
  return response.parsed_output ?? { verdict: "not_supported", explanation: "Verification call failed to parse." };
}

export interface IncidentSummary {
  rootCause: string;
  confidence: "high" | "medium" | "low";
  verification: { verdict: string; explanation: string };
  citedEvidence: IncidentEvidence[];
  searchTermsUsed: string[];
  retried: boolean;
}

/**
 * Full pipeline: extract search terms -> retrieve evidence -> generate a
 * grounded hypothesis -> verify it against its own cited evidence -> if
 * unsupported, retry once with an explicit "be conservative" instruction.
 */
export async function summarizeIncident(
  query: string,
  searchFn: (term: string) => SearchMatch[]
): Promise<IncidentSummary | { error: string }> {
  const terms = await extractSearchTerms(query);

  const evidenceById = new Map<number, IncidentEvidence>();
  for (const term of terms) {
    for (const m of searchFn(term)) {
      evidenceById.set(m.id, { id: m.id, line: m.line });
    }
  }
  const evidence = [...evidenceById.values()].sort((a, b) => a.id - b.id);

  if (evidence.length === 0) {
    return { error: `No log evidence found for "${query}" (searched: ${terms.join(", ")}).` };
  }

  let hypothesis = await generateHypothesis(query, evidence);
  if (!hypothesis) return { error: "Failed to generate a hypothesis (LLM parse failure)." };

  let citedEvidence = evidence.filter((e) => hypothesis!.citedLineIds.includes(e.id));
  let verification = await verifyHypothesis(hypothesis, citedEvidence);
  let retried = false;

  if (verification.verdict === "not_supported") {
    retried = true;
    hypothesis = await generateHypothesis(
      `${query}\n\n(Note: a previous attempt was rejected as unsupported by the evidence — ` +
        `be conservative and only claim what the lines directly show.)`,
      evidence
    );
    if (!hypothesis) return { error: "Failed to generate a hypothesis on retry." };
    citedEvidence = evidence.filter((e) => hypothesis!.citedLineIds.includes(e.id));
    verification = await verifyHypothesis(hypothesis, citedEvidence);
  }

  return {
    rootCause: hypothesis.rootCause,
    confidence: hypothesis.confidence,
    verification,
    citedEvidence,
    searchTermsUsed: terms,
    retried,
  };
}
