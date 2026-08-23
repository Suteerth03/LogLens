export interface EvalCase {
  id: string;
  /** Path relative to the evals/ directory. */
  logFile: string;
  query: string;
  /** Plain-English statement of the true root cause, for the report. */
  expectedRootCause: string;
  /**
   * Concept groups the produced rootCause text must hit — at least one string
   * from each group must appear (case-insensitive). Deliberately allows
   * synonyms so scoring rewards the right diagnosis, not exact phrasing.
   */
  mustMention: string[][];
  /**
   * Evidence the answer must cite. Each inner array is a group; at least one
   * id from each group must appear in citedEvidence. These are the lines that
   * carry the *upstream* cause — citing only the loud failure lines is the
   * failure mode this is designed to catch.
   */
  mustCite: number[][];
  /** For healthy logs: the correct answer is "nothing failed". */
  expectNoFailure?: boolean;
}

export const CASES: EvalCase[] = [
  {
    id: "01-db-pool-exhaustion",
    logFile: "../fixtures/sample.log",
    query: "why did checkout fail around 9:31",
    expectedRootCause:
      "A long-running query (q-88213) in inventory-service held a connection from the shared " +
      "db-primary pool for ~3 minutes, exhausting it and starving checkout-service.",
    mustMention: [
      ["inventory", "q-88213", "long-running", "long running"],
      ["pool", "connection"],
    ],
    mustCite: [[23, 24, 28]],
  },
  {
    id: "02-memory-leak",
    logFile: "logs/02-memory-leak.log",
    query: "why did report-service run out of memory around 9:56",
    expectedRootCause:
      "The 'user-prefs' cache was configured with no eviction policy and grew unbounded to 241k " +
      "entries, consuming the heap until an OutOfMemoryError.",
    mustMention: [
      ["cache", "user-prefs"],
      ["evict", "unbounded", "grew", "growth", "leak", "no limit"],
    ],
    mustCite: [[1, 5]],
  },
  {
    id: "03-retry-storm",
    logFile: "logs/03-retry-storm.log",
    query: "why did pricing-api become degraded at 14:02",
    expectedRootCause:
      "A transient upstream 503 triggered mobile-client-gw's retry policy, which had no backoff " +
      "and unlimited attempts, amplifying load ~28x and saturating pricing-api's thread pool.",
    mustMention: [
      ["retry", "retries", "retrying"],
      ["backoff", "unlimited", "storm", "amplif", "client"],
    ],
    mustCite: [[2, 4]],
  },
  {
    id: "04-bad-deploy",
    logFile: "logs/04-bad-deploy.log",
    query: "why are users being logged out unexpectedly around 11:16",
    expectedRootCause:
      "The v4.12.0 rollout changed the token signing algorithm from HS256 to RS256, so tokens " +
      "issued before the deploy failed signature validation and sessions were invalidated.",
    mustMention: [
      ["signing", "algorithm", "hs256", "rs256"],
      ["deploy", "rollout", "v4.12", "config change"],
    ],
    mustCite: [[1, 2]],
  },
  {
    id: "05-disk-full",
    logFile: "logs/05-disk-full.log",
    query: "why did media-service uploads start failing at 06:51",
    expectedRootCause:
      "Debug logging was left enabled while log rotation was repeatedly blocked by a file lock, " +
      "growing the log to 214GB and filling the /data volume.",
    mustMention: [
      ["rotation", "rotate", "logrotate", "debug logging", "log file"],
      ["disk", "space", "volume", "214gb", "full"],
    ],
    mustCite: [[1], [2, 3, 4]],
  },
  {
    id: "06-clock-skew",
    logFile: "logs/06-clock-skew.log",
    query: "why are some JWT validations failing around 16:20",
    expectedRootCause:
      "node-c's NTP sync failed, leaving its clock 139s behind its peers, so it rejected valid " +
      "tokens whose 'nbf' claim appeared to be in the future.",
    mustMention: [
      ["clock", "ntp", "time", "skew", "drift"],
      ["node-c"],
    ],
    mustCite: [[1, 8]],
  },
  {
    id: "07-healthy",
    logFile: "logs/07-healthy.log",
    query: "what caused the outage in orders-service this morning",
    expectedRootCause: "Nothing failed — the log shows only normal operation.",
    mustMention: [["no failure", "no error", "healthy", "normal", "no outage", "did not fail", "no evidence"]],
    mustCite: [],
    expectNoFailure: true,
  },
  {
    id: "08-misleading-symptom",
    logFile: "logs/08-misleading-symptom.log",
    query: "why is the payment decline rate spiking at 13:09",
    expectedRootCause:
      "An FX rate table reload switched to vendor-b, whose INR quote used the inverse unit " +
      "convention (0.0119 vs 83.4), inflating converted amounts ~7000x past the processor's " +
      "per-transaction limit. 'Amount exceeds limit' is the symptom, not the cause.",
    mustMention: [
      ["fx", "exchange rate", "currency", "conversion", "rate table"],
      ["vendor-b", "unit", "convention", "0.0119", "invert", "reciprocal", "wrong"],
    ],
    mustCite: [[1, 2]],
  },
];
