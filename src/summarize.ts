import { GoogleGenAI } from "@google/genai";
import type { SearchMatch } from "./logParser.js";

// Mixed-model strategy: Flash for the cheap keyword-extraction step, Pro for
// the two steps where reasoning quality actually matters (root-cause
// generation and the hallucination-check verification pass). Same split as
// the original Haiku/Opus design — just swapped to Gemini's free tier.
const FLASH = "gemini-2.5-flash";
const PRO = "gemini-2.5-pro";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Gemini's responseJsonSchema accepts a restricted subset of JSON Schema —
// hand-written plain objects here rather than a Zod->JSON-Schema conversion,
// since the subset doesn't support every keyword a converter might emit.
const SEARCH_TERMS_SCHEMA = {
  type: "object",
  properties: {
    terms: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 5,
      description:
        "Short keywords/phrases likely to appear verbatim in log lines related to the question " +
        "(error names, service names, identifiers) — not a paraphrase of the question itself.",
    },
  },
  required: ["terms"],
} as const;

const HYPOTHESIS_SCHEMA = {
  type: "object",
  properties: {
    rootCause: { type: "string", description: "A concise root-cause explanation, one to three sentences." },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    citedLineIds: {
      type: "array",
      items: { type: "integer" },
      description: "The 'id' values of the specific evidence lines this hypothesis is based on.",
    },
  },
  required: ["rootCause", "confidence", "citedLineIds"],
} as const;

const VERIFICATION_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["supported", "partially_supported", "not_supported"] },
    explanation: { type: "string", description: "Why the cited lines do or do not support the root-cause claim." },
  },
  required: ["verdict", "explanation"],
} as const;

interface SearchTerms {
  terms: string[];
}
interface Hypothesis {
  rootCause: string;
  confidence: "high" | "medium" | "low";
  citedLineIds: number[];
}
interface Verification {
  verdict: "supported" | "partially_supported" | "not_supported";
  explanation: string;
}

async function generateJson<T>(model: string, systemInstruction: string, prompt: string, schema: object): Promise<T | null> {
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    },
  });
  if (!response.text) return null;
  try {
    return JSON.parse(response.text) as T;
  } catch {
    return null;
  }
}

/**
 * Step 1: turn a natural-language question into search terms likely to
 * appear verbatim in log lines, instead of substring-matching the raw
 * question (the Week 1 limitation noted in the README).
 */
async function extractSearchTerms(query: string): Promise<string[]> {
  const result = await generateJson<SearchTerms>(
    FLASH,
    "You turn a natural-language incident question into short search keywords that would " +
      "literally appear in application log lines. Prefer terms likely to appear verbatim " +
      "(error class names, service names, identifiers) over paraphrases of the question.",
    query,
    SEARCH_TERMS_SCHEMA
  );
  return result?.terms ?? [query];
}

export interface IncidentEvidence {
  id: number;
  line: string;
}

/** Step 2: generate a root-cause hypothesis grounded only in retrieved evidence. */
async function generateHypothesis(query: string, evidence: IncidentEvidence[]): Promise<Hypothesis | null> {
  const evidenceText = evidence.map((e) => `[id=${e.id}] ${e.line}`).join("\n");
  return generateJson<Hypothesis>(
    PRO,
    "You are a root-cause analysis assistant for application logs. You are given a question " +
      "and a set of retrieved log lines, each tagged with an id. Base your root-cause hypothesis " +
      "ONLY on these lines — do not invent services, errors, or events not present in the evidence. " +
      "Cite the specific line ids that support your conclusion.",
    `Question: ${query}\n\nRetrieved log evidence:\n${evidenceText}`,
    HYPOTHESIS_SCHEMA
  );
}

/**
 * Step 3 — the hallucination-check loop: independently judge whether the
 * *cited* lines actually support the claim, rather than trusting the model
 * that generated the claim to grade its own homework.
 */
async function verifyHypothesis(hypothesis: Hypothesis, citedEvidence: IncidentEvidence[]): Promise<Verification> {
  const evidenceText =
    citedEvidence.map((e) => `[id=${e.id}] ${e.line}`).join("\n") ||
    "(none — the hypothesis cited no line ids that exist in the retrieved evidence)";
  const result = await generateJson<Verification>(
    PRO,
    "You are a strict fact-checker. Given a root-cause claim and ONLY the specific log lines it " +
      "cites as support, judge whether those lines actually substantiate the claim. Be skeptical: " +
      "a plausible-sounding claim not directly backed by the cited lines is 'not_supported' or " +
      "'partially_supported', never 'supported'.",
    `Claim: ${hypothesis.rootCause}\n\nCited evidence:\n${evidenceText}`,
    VERIFICATION_SCHEMA
  );
  return result ?? { verdict: "not_supported", explanation: "Verification call failed to parse." };
}

export interface IncidentSummary {
  rootCause: string;
  confidence: "high" | "medium" | "low";
  verification: Verification;
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
  // Fail fast with a clear message — without this, an unset key makes the
  // SDK fall back to trying Google Cloud Application Default Credentials
  // and fail with an unrelated-looking "Could not load the default
  // credentials" error instead of the obvious "set GEMINI_API_KEY" one.
  if (!process.env.GEMINI_API_KEY) {
    return { error: "GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey" };
  }

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
