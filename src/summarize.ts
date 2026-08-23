import { searchLogs, expandByTimeWindow, collectAnomalies, isAnomaly, type LogLine } from "./logParser.js";
import { MODELS, generateJson, isConfigured, type ModelSpec } from "./providers.js";

// Schemas stay within the intersection Groq strict mode and Gemini's
// responseJsonSchema both accept: no minItems/maxItems, additionalProperties
// always false. Count limits live in descriptions instead of keywords.
const SEARCH_TERMS_SCHEMA = {
  type: "object",
  properties: {
    terms: {
      type: "array",
      items: { type: "string" },
      description:
        "One to five short keywords/phrases likely to appear verbatim in log lines related to the " +
        "question (error names, service names, identifiers) — not a paraphrase of the question.",
    },
  },
  required: ["terms"],
  additionalProperties: false,
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
  additionalProperties: false,
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
        "Ids of retrieved lines the claim fails to account for — especially ones suggesting a deeper " +
        "cause. Empty if the claim is complete.",
    },
  },
  required: ["soundness", "completeness", "explanation", "overlookedLineIds"],
  additionalProperties: false,
} as const;

interface SearchTerms {
  terms: string[];
}
interface Hypothesis {
  rootCause: string;
  confidence: "high" | "medium" | "low";
  citedLineIds: number[];
}
interface VerificationCore {
  soundness: "supported" | "partially_supported" | "not_supported";
  completeness: "complete" | "incomplete";
  explanation: string;
  overlookedLineIds: number[];
}
export interface Verification extends VerificationCore {
  /** Which model judged the claim. */
  verifierModel: string;
  /**
   * True when the verifier ran on a different provider than the hypothesis
   * generator. False means the check shares the generator's blind spots and
   * is correspondingly weaker — surfaced rather than hidden.
   */
  independent: boolean;
}

/**
 * Step 1: turn a natural-language question into search terms likely to appear
 * verbatim in log lines, instead of substring-matching the raw question.
 */
async function extractSearchTerms(query: string): Promise<string[]> {
  const result = await generateJson<SearchTerms>(
    MODELS.extraction,
    "search_terms",
    "You turn a natural-language incident question into short search keywords that would " +
      "literally appear in application log lines. Prefer terms likely to appear verbatim " +
      "(error class names, service names, identifiers) over paraphrases of the question.",
    query,
    SEARCH_TERMS_SCHEMA
  );
  const terms = result?.terms?.filter((t) => t.trim().length > 0) ?? [];
  return terms.length > 0 ? terms.slice(0, 5) : [query];
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
    MODELS.hypothesis,
    "hypothesis",
    "You are a root-cause analysis assistant for application logs. You are given a question " +
      "and a set of retrieved log lines, each tagged with an id. Base your root-cause hypothesis " +
      "ONLY on these lines — do not invent services, errors, or events not present in the evidence. " +
      "Look past the immediate failure: if the evidence shows an upstream or cross-service cause " +
      "(something holding a resource, a slow dependency, a config change), that is the root cause, " +
      "not the symptom it produced. If the evidence shows no failure at all, say so plainly rather " +
      "than manufacturing one. Cite the specific line ids that support your conclusion.",
    prompt,
    HYPOTHESIS_SCHEMA
  );
}

const VERIFIER_SYSTEM =
  "You are a strict fact-checker for root-cause claims about logs. Judge two things independently. " +
  "(1) SOUNDNESS: do the cited lines actually substantiate the claim? Be skeptical — a " +
  "plausible-sounding claim not directly backed by its cited lines is not 'supported'. " +
  "(2) COMPLETENESS: scan the FULL evidence set for anything the claim fails to account for. " +
  "If other lines reveal a deeper or upstream cause — another service holding a shared resource, " +
  "a slow query, a config or deploy change, a failing dependency — then the claim describes a " +
  "symptom rather than the root cause and is 'incomplete'. List those overlooked line ids. A claim " +
  "can be perfectly sound and still incomplete; judge the axes separately.";

/**
 * Step 3 — verification on two independent axes, on a different model family.
 *
 * An earlier single-axis version was handed ONLY the cited lines, which made
 * it structurally incapable of catching an incomplete answer: a claim that
 * correctly describes a symptom will always look "supported" by the lines it
 * chose to cite. It now also sees the FULL evidence set.
 *
 * Runs on a different provider than `generateHypothesis` so the check does not
 * inherit the generator's blind spots. Falls back to a same-provider model if
 * the cross-provider one is unavailable, and reports that it did.
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

  const attempt = async (spec: ModelSpec): Promise<Verification | null> => {
    const core = await generateJson<VerificationCore>(spec, "verification", VERIFIER_SYSTEM, prompt, VERIFICATION_SCHEMA);
    if (!core) return null;
    return {
      ...core,
      overlookedLineIds: core.overlookedLineIds ?? [],
      verifierModel: spec.model,
      independent: spec.provider !== MODELS.hypothesis.provider,
    };
  };

  if (isConfigured(MODELS.verification.provider)) {
    try {
      const result = await attempt(MODELS.verification);
      if (result) return result;
    } catch {
      // Cross-provider verifier unavailable (quota, outage, bad key) — degrade
      // to same-provider rather than failing the whole pipeline.
    }
  }

  const fallback = await attempt(MODELS.verificationFallback);
  return (
    fallback ?? {
      soundness: "not_supported",
      completeness: "incomplete",
      explanation: "Verification call failed to parse.",
      overlookedLineIds: [],
      verifierModel: MODELS.verificationFallback.model,
      independent: false,
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
  /** Every line id that reached the model — lets callers tell a retrieval miss from a reasoning miss. */
  retrievedIds: number[];
  retried: boolean;
}

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
  if (!isConfigured("groq")) {
    return { error: "GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys" };
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
    const line = byId.get(id);
    return line !== undefined && isAnomaly(line);
  });
  const seedIds = anomalyIds.length > 0 ? anomalyIds : matchedIds;

  for (const l of expandByTimeWindow(lines, seedIds)) {
    evidenceById.set(l.id, { id: l.id, line: l.raw, viaExpansion: true });
  }
  // Anomalous lines anywhere in the log, not just inside the window — the
  // explaining line is often a warning that precedes the errors by more than
  // any window we'd want to apply to ordinary INFO lines.
  for (const l of collectAnomalies(lines, [...evidenceById.keys()])) {
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
    retrievedIds: evidence.map((e) => e.id),
    retried,
  };
}
