import { GoogleGenAI } from "@google/genai";
import { searchLogs, expandByTimeWindow, type LogLine } from "./logParser.js";

// Mixed-model strategy: Flash for the cheap keyword-extraction step, Pro for
// the two steps where reasoning quality actually matters (root-cause
// generation and the hallucination-check verification pass). Same split as
// the original Haiku/Opus design — just swapped to Gemini's free tier.
const FLASH = "gemini-3.6-flash";
// Free tier currently shows zero quota for pro-tier models on this key
// (confirmed via a live 429 with `limit: 0`, not a temporary rate limit) —
// using Flash for all three steps until that's resolved. See README.
const PRO = "gemini-3.6-flash";

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
    soundness: {
      type: "string",
      enum: ["supported", "partially_supported", "not_supported"],
      description: "Do the CITED lines actually substantiate the claim?",
    },
    completeness: {
      type: "string",
      enum: ["complete", "incomplete"],
      description:
        "Does the claim account for everything the FULL evidence set shows, or does other retrieved " +
        "evidence point to a deeper/upstream cause the claim missed?",
    },
    explanation: { type: "string" },
    overlookedLineIds: {
      type: "array",
      items: { type: "integer" },
      description:
        "Ids of retrieved lines that the claim fails to account for — especially ones suggesting a " +
        "deeper cause. Empty if the claim is complete.",
    },
  },
  required: ["soundness", "completeness", "explanation", "overlookedLineIds"],
} as const;

interface SearchTerms {
  terms: string[];
}
interface Hypothesis {
  rootCause: string;
  confidence: "high" | "medium" | "low";
  citedLineIds: number[];
}
export interface Verification {
  soundness: "supported" | "partially_supported" | "not_supported";
  completeness: "complete" | "incomplete";
  explanation: string;
  overlookedLineIds: number[];
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
 * question.
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
  /** True when this line entered the evidence set via time-window expansion, not a term match. */
  viaExpansion?: boolean;
}

function renderEvidence(evidence: IncidentEvidence[]): string {
  return evidence.map((e) => `[id=${e.id}] ${e.line}`).join("\n");
}

/** Step 2: generate a root-cause hypothesis grounded only in retrieved evidence. */
async function generateHypothesis(
  query: string,
  evidence: IncidentEvidence[],
  guidance?: string
): Promise<Hypothesis | null> {
  const prompt = [
    `Question: ${query}`,
    "",
    "Retrieved log evidence:",
    renderEvidence(evidence),
    guidance ? `\nIMPORTANT GUIDANCE FROM A PREVIOUS REVIEW:\n${guidance}` : "",
  ].join("\n");

  return generateJson<Hypothesis>(
    PRO,
    "You are a root-cause analysis assistant for application logs. You are given a question " +
      "and a set of retrieved log lines, each tagged with an id. Base your root-cause hypothesis " +
      "ONLY on these lines — do not invent services, errors, or events not present in the evidence. " +
      "Look past the immediate failure: if the evidence shows an upstream or cross-service cause " +
      "(something holding a resource, a slow dependency), that is the root cause, not the symptom " +
      "it produced. Cite the specific line ids that support your conclusion.",
    prompt,
    HYPOTHESIS_SCHEMA
  );
}

/**
 * Step 3 — verification on two independent axes.
 *
 * The earlier single-axis version was handed ONLY the cited lines, which made
 * it structurally incapable of catching an incomplete answer: a claim that
 * correctly describes a symptom will always look "supported" by the lines it
 * chose to cite. Real testing hit exactly that — a verdict of `supported` on
 * an answer that missed the actual upstream cause. So the verifier now also
 * sees the FULL evidence set and judges:
 *   - soundness:    do the cited lines substantiate the claim?
 *   - completeness: does other retrieved evidence point somewhere the claim missed?
 */
async function verifyHypothesis(
  hypothesis: Hypothesis,
  citedEvidence: IncidentEvidence[],
  allEvidence: IncidentEvidence[]
): Promise<Verification> {
  const citedText =
    renderEvidence(citedEvidence) ||
    "(none — the hypothesis cited no line ids that exist in the retrieved evidence)";

  const prompt = [
    `Claim: ${hypothesis.rootCause}`,
    "",
    "Lines the claim cites as support:",
    citedText,
    "",
    "FULL retrieved evidence set (includes lines the claim did not cite):",
    renderEvidence(allEvidence),
  ].join("\n");

  const result = await generateJson<Verification>(
    PRO,
    "You are a strict fact-checker for root-cause claims about logs. Judge two things independently. " +
      "(1) SOUNDNESS: do the cited lines actually substantiate the claim? Be skeptical — a " +
      "plausible-sounding claim not directly backed by its cited lines is not 'supported'. " +
      "(2) COMPLETENESS: scan the FULL evidence set for anything the claim fails to account for. " +
      "If other lines reveal a deeper or upstream cause — another service holding a shared resource, " +
      "a slow query, a dependency failure — then the claim describes a symptom rather than the root " +
      "cause and is 'incomplete'. List those overlooked line ids. A claim can be perfectly sound and " +
      "still incomplete; judge the axes separately.",
    prompt,
    VERIFICATION_SCHEMA
  );

  return (
    result ?? {
      soundness: "not_supported",
      completeness: "incomplete",
      explanation: "Verification call failed to parse.",
      overlookedLineIds: [],
    }
  );
}

export interface IncidentSummary {
  rootCause: string;
  confidence: "high" | "medium" | "low";
  verification: Verification;
  citedEvidence: IncidentEvidence[];
  searchTermsUsed: string[];
  evidenceCount: { fromSearch: number; fromExpansion: number };
  retried: boolean;
}

const ANOMALY_LEVELS = new Set(["ERROR", "FATAL", "WARN", "WARNING"]);

/**
 * Full pipeline: extract search terms -> retrieve (lexical + time-window
 * expansion) -> generate a grounded hypothesis -> verify on soundness and
 * completeness -> regenerate once if unsound or incomplete, feeding back the
 * lines the first attempt overlooked.
 */
export async function summarizeIncident(
  query: string,
  lines: LogLine[]
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
    for (const m of searchLogs(lines, term, { contextSize: 3 })) {
      evidenceById.set(m.id, { id: m.id, line: m.line });
    }
  }
  const fromSearch = evidenceById.size;

  if (fromSearch === 0) {
    return { error: `No log evidence found for "${query}" (searched: ${terms.join(", ")}).` };
  }

  // Seed the time window from the anomalous matches where possible — seeding
  // from every match (including routine INFO lines spanning the whole file)
  // would widen the window to the entire log and defeat the point.
  const byId = new Map(lines.map((l) => [l.id, l]));
  const matchedIds = [...evidenceById.keys()];
  const anomalyIds = matchedIds.filter((id) => {
    const level = byId.get(id)?.level?.toUpperCase();
    return level !== undefined && ANOMALY_LEVELS.has(level);
  });
  const seedIds = anomalyIds.length > 0 ? anomalyIds : matchedIds;

  for (const l of expandByTimeWindow(lines, seedIds)) {
    evidenceById.set(l.id, { id: l.id, line: l.raw, viaExpansion: true });
  }

  const evidence = [...evidenceById.values()].sort((a, b) => a.id - b.id);
  const evidenceCount = { fromSearch, fromExpansion: evidence.length - fromSearch };

  let hypothesis = await generateHypothesis(query, evidence);
  if (!hypothesis) return { error: "Failed to generate a hypothesis (LLM parse failure)." };

  let citedEvidence = evidence.filter((e) => hypothesis!.citedLineIds.includes(e.id));
  let verification = await verifyHypothesis(hypothesis, citedEvidence, evidence);
  let retried = false;

  if (verification.soundness === "not_supported" || verification.completeness === "incomplete") {
    retried = true;

    const overlooked = evidence.filter((e) => verification.overlookedLineIds.includes(e.id));
    const guidance = [
      `A previous attempt was rejected (soundness: ${verification.soundness}, completeness: ${verification.completeness}).`,
      `Reviewer's reasoning: ${verification.explanation}`,
      overlooked.length > 0
        ? `You overlooked these lines — account for them, and consider whether they reveal the ` +
          `true upstream cause rather than the symptom you described:\n${renderEvidence(overlooked)}`
        : "Only claim what the evidence directly shows.",
    ].join("\n");

    hypothesis = await generateHypothesis(query, evidence, guidance);
    if (!hypothesis) return { error: "Failed to generate a hypothesis on retry." };

    citedEvidence = evidence.filter((e) => hypothesis!.citedLineIds.includes(e.id));
    verification = await verifyHypothesis(hypothesis, citedEvidence, evidence);
  }

  return {
    rootCause: hypothesis.rootCause,
    confidence: hypothesis.confidence,
    verification,
    citedEvidence,
    searchTermsUsed: terms,
    evidenceCount,
    retried,
  };
}
