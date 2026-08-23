/**
 * Eval harness for LogLens.
 *
 * Calls summarizeIncident directly (not over MCP) — this measures the
 * algorithm, not the transport. Scoring is deterministic: no LLM judge, so
 * runs are reproducible and cost nothing beyond the pipeline itself.
 *
 *   npx tsx evals/run-evals.ts              # all cases
 *   npx tsx evals/run-evals.ts 03 08        # only cases whose id contains these
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLog } from "../src/logParser.js";
import { summarizeIncident, type IncidentSummary } from "../src/summarize.js";
import { CASES, type EvalCase } from "./cases.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Pause between cases so a burst of runs doesn't trip free-tier per-minute limits. */
const PAUSE_MS = 4000;

interface CaseResult {
  id: string;
  passed: boolean;
  /** Required evidence was retrieved at all (separates retrieval misses from reasoning misses). */
  retrievalOk: boolean;
  citationOk: boolean;
  mentionOk: boolean;
  missingConcepts: string[][];
  missingCitations: number[][];
  soundness?: string;
  completeness?: string;
  retried?: boolean;
  rootCause: string;
  seconds: number;
  error?: string;
}

/**
 * Models routinely emit typographic punctuation — U+2011 non-breaking hyphen
 * in "node‑c", curly quotes, non-breaking spaces. Naive substring matching
 * then reports a concept as missing when the answer plainly contains it,
 * which scored a correct answer as FAIL before this was normalized.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-") // hyphens, dashes, minus sign
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u00a0/g, " "); // non-breaking space
}

const hitsGroup = (haystack: string, group: string[]) =>
  group.some((needle) => haystack.includes(normalize(needle)));

/**
 * The free tier enforces a per-DAY request cap (20 at time of writing) as well
 * as per-minute limits. A per-minute 429 is worth waiting out; a per-day one
 * is fatal for the run and should abort immediately rather than burn the
 * remaining cases into identical errors and pollute the report.
 */
function classifyQuotaError(message: string): { daily: boolean; retryAfterMs: number | null } {
  const daily = /PerDay/i.test(message);
  const m = message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (m) return { daily, retryAfterMs: Math.ceil(parseFloat(m[1]) * 1000) + 1000 };
  // Groq signals a per-minute token-budget overrun as a 413 with no retry
  // hint; the budget refills on a rolling minute, so waiting one out works.
  if (/rate_limit_exceeded|tokens per minute|TPM/i.test(message)) {
    return { daily: false, retryAfterMs: 62_000 };
  }
  return { daily, retryAfterMs: null };
}

class DailyQuotaExhausted extends Error {}

function scoreNoFailureCase(c: EvalCase, result: IncidentSummary | { error: string }): Partial<CaseResult> {
  // Two acceptable shapes: retrieval found nothing (correct — there is no
  // failure to find), or it produced a claim that says nothing failed.
  if ("error" in result) {
    return { passed: true, retrievalOk: true, citationOk: true, mentionOk: true, rootCause: `(no evidence) ${result.error}` };
  }
  const text = normalize(result.rootCause);
  const mentionOk = c.mustMention.every((g) => hitsGroup(text, g));
  return {
    passed: mentionOk,
    retrievalOk: true,
    citationOk: true,
    mentionOk,
    missingConcepts: c.mustMention.filter((g) => !hitsGroup(text, g)),
    soundness: result.verification.soundness,
    completeness: result.verification.completeness,
    retried: result.retried,
    rootCause: result.rootCause,
  };
}

async function runCase(c: EvalCase): Promise<CaseResult> {
  const started = Date.now();
  const base: CaseResult = {
    id: c.id,
    passed: false,
    retrievalOk: false,
    citationOk: false,
    mentionOk: false,
    missingConcepts: [],
    missingCitations: [],
    rootCause: "",
    seconds: 0,
  };

  const lines = loadLog(fs.readFileSync(path.resolve(HERE, c.logFile), "utf-8"));

  let result: IncidentSummary | { error: string };
  try {
    result = await summarizeIncident(c.query, lines);
  } catch (err) {
    const message = (err as Error).message;
    const { daily, retryAfterMs } = classifyQuotaError(message);
    if (daily) throw new DailyQuotaExhausted(message);

    if (retryAfterMs === null) {
      return { ...base, error: message, seconds: (Date.now() - started) / 1000 };
    }
    // Per-minute limit: wait it out once, then give up on this case.
    console.log(`\n      rate limited, waiting ${(retryAfterMs / 1000).toFixed(0)}s ...`);
    await new Promise((res) => setTimeout(res, retryAfterMs));
    try {
      result = await summarizeIncident(c.query, lines);
    } catch (retryErr) {
      const retryMessage = (retryErr as Error).message;
      if (classifyQuotaError(retryMessage).daily) throw new DailyQuotaExhausted(retryMessage);
      return { ...base, error: retryMessage, seconds: (Date.now() - started) / 1000 };
    }
  }

  const seconds = (Date.now() - started) / 1000;

  if (c.expectNoFailure) {
    return { ...base, ...scoreNoFailureCase(c, result), seconds } as CaseResult;
  }

  if ("error" in result) {
    return { ...base, error: result.error, seconds };
  }

  const text = normalize(result.rootCause);
  const citedIds = new Set(result.citedEvidence.map((e) => e.id));
  const retrievedIds = new Set(result.retrievedIds);

  const missingConcepts = c.mustMention.filter((g) => !hitsGroup(text, g));
  const missingCitations = c.mustCite.filter((g) => !g.some((id) => citedIds.has(id)));
  const retrievalOk = c.mustCite.every((g) => g.some((id) => retrievedIds.has(id)));

  const mentionOk = missingConcepts.length === 0;
  const citationOk = missingCitations.length === 0;

  return {
    id: c.id,
    passed: mentionOk && citationOk,
    retrievalOk,
    citationOk,
    mentionOk,
    missingConcepts,
    missingCitations,
    soundness: result.verification.soundness,
    completeness: result.verification.completeness,
    retried: result.retried,
    rootCause: result.rootCause,
    seconds,
  };
}

async function main() {
  if (!process.env.GROQ_API_KEY) {
    console.error("GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys");
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.warn(
      "warning: GEMINI_API_KEY not set — verification will fall back to the same provider as the\n" +
        "         hypothesis generator, so the check is no longer independent. Results still valid,\n" +
        "         but weaker than a cross-provider run.\n"
    );
  }

  const filters = process.argv.slice(2);
  const cases = filters.length > 0 ? CASES.filter((c) => filters.some((f) => c.id.includes(f))) : CASES;

  if (cases.length === 0) {
    console.error(`No cases matched: ${filters.join(", ")}`);
    process.exit(1);
  }

  console.log(`Running ${cases.length} eval case(s)\n`);
  const results: CaseResult[] = [];

  let abortedAt: string | null = null;

  for (const [i, c] of cases.entries()) {
    process.stdout.write(`[${i + 1}/${cases.length}] ${c.id} ... `);
    try {
      const r = await runCase(c);
      results.push(r);
      console.log(
        r.error ? `ERROR (${r.seconds.toFixed(1)}s)` : `${r.passed ? "PASS" : "FAIL"} (${r.seconds.toFixed(1)}s)`
      );
    } catch (err) {
      if (err instanceof DailyQuotaExhausted) {
        console.log("ABORTED");
        abortedAt = c.id;
        break;
      }
      throw err;
    }
    if (i < cases.length - 1) await new Promise((res) => setTimeout(res, PAUSE_MS));
  }

  if (abortedAt) {
    console.log(
      `\n!! Daily free-tier request quota exhausted at "${abortedAt}".` +
        `\n   A full pass costs 3-4 requests per case; the free tier allows 20 requests/day.` +
        `\n   Run a subset (e.g. \`npx tsx evals/run-evals.ts 03 04\`) or use a paid key.` +
        `\n   Reporting only the ${results.length} case(s) that completed.\n`
    );
  }

  if (results.length === 0) {
    console.log("No cases completed — nothing to report.");
    process.exit(1);
  }

  console.log("\n" + "=".repeat(76));
  console.log("RESULTS");
  console.log("=".repeat(76));

  for (const r of results) {
    console.log(`\n${r.passed ? "PASS" : "FAIL"}  ${r.id}   (${r.seconds.toFixed(1)}s)`);
    if (r.error) {
      console.log(`  error: ${r.error}`);
      continue;
    }
    console.log(`  verification: soundness=${r.soundness}, completeness=${r.completeness}, regenerated=${r.retried}`);
    console.log(`  answer: ${r.rootCause}`);
    if (!r.passed) {
      // Distinguishing these two is the point: a retrieval miss means the
      // evidence never reached the model; a reasoning miss means it did and
      // the model still got it wrong. They need different fixes.
      if (!r.retrievalOk) console.log(`  >> RETRIEVAL MISS: required evidence never entered the evidence set`);
      if (r.missingCitations.length > 0)
        console.log(`  >> uncited required evidence groups: ${JSON.stringify(r.missingCitations)}`);
      if (r.missingConcepts.length > 0)
        console.log(`  >> missing concepts: ${r.missingConcepts.map((g) => g[0]).join(", ")}`);
    }
  }

  // Scored = cases that actually produced an answer. Errored cases are NOT
  // failures of the algorithm and must not be folded into the miss counts —
  // doing so reports infrastructure problems as retrieval problems.
  const errored = results.filter((r) => r.error);
  const scored = results.filter((r) => !r.error);
  const passed = scored.filter((r) => r.passed).length;
  const retrievalMisses = scored.filter((r) => !r.passed && !r.retrievalOk).length;
  const reasoningMisses = scored.filter((r) => !r.passed && r.retrievalOk).length;
  const avg = scored.length > 0 ? scored.reduce((s, r) => s + r.seconds, 0) / scored.length : 0;

  console.log("\n" + "=".repeat(76));
  console.log(`Scored:            ${scored.length}/${CASES.length} cases (${errored.length} errored, not scored)`);
  if (scored.length > 0) {
    console.log(`Passed:            ${passed}/${scored.length}`);
    console.log(`Retrieval misses:  ${retrievalMisses}   (required evidence never reached the model)`);
    console.log(`Reasoning misses:  ${reasoningMisses}   (evidence was there, answer still wrong)`);
    console.log(`Regenerated:       ${scored.filter((r) => r.retried).length}/${scored.length}`);
    console.log(`Avg latency:       ${avg.toFixed(1)}s`);
  }
  console.log("=".repeat(76));

  process.exit(scored.length > 0 && passed === scored.length && errored.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Eval harness failed:", err);
  process.exit(1);
});
