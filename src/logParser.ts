export interface LogLine {
  id: number;
  raw: string;
  timestamp?: string;
  level?: string;
}

const LOG_PREFIX_RE =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(\w+)\s+/;

/** Parses raw log text into indexed, lightly-structured lines. */
export function loadLog(rawText: string): LogLine[] {
  return rawText
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((raw, id) => {
      const m = raw.match(LOG_PREFIX_RE);
      return { id, raw, timestamp: m?.[1], level: m?.[2] };
    });
}

export interface SearchMatch {
  id: number;
  line: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface SearchOptions {
  contextSize?: number;
  caseSensitive?: boolean;
  /** ISO timestamps; only lines with a parsed timestamp in range are considered. */
  timeRange?: { from?: string; to?: string };
}

/** Substring search over log lines, returning each match with surrounding context. */
export function searchLogs(
  lines: LogLine[],
  query: string,
  opts: SearchOptions = {}
): SearchMatch[] {
  const { contextSize = 2, caseSensitive = false, timeRange } = opts;
  const needle = caseSensitive ? query : query.toLowerCase();

  return lines
    .filter((line) => {
      if (timeRange?.from && line.timestamp && line.timestamp < timeRange.from) return false;
      if (timeRange?.to && line.timestamp && line.timestamp > timeRange.to) return false;
      const haystack = caseSensitive ? line.raw : line.raw.toLowerCase();
      return haystack.includes(needle);
    })
    .map((line) => ({
      id: line.id,
      line: line.raw,
      contextBefore: lines.slice(Math.max(0, line.id - contextSize), line.id).map((l) => l.raw),
      contextAfter: lines.slice(line.id + 1, line.id + 1 + contextSize).map((l) => l.raw),
    }));
}

function parseTimestampMs(ts: string | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts.replace(" ", "T"));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Returns lines that fall within `windowSeconds` of the seed lines but were
 * NOT themselves matched by any search term.
 *
 * This is what catches cross-service root causes: a question about
 * "checkout failing" produces checkout-scoped search terms, so the upstream
 * service actually holding the resource never enters the evidence set by
 * lexical match alone — but it is right there in the same time window.
 *
 * Capped by `maxLines`, keeping the lines closest in time to a seed, so a
 * wide seed span can't pull an entire log file into the prompt.
 */
export function expandByTimeWindow(
  lines: LogLine[],
  seedIds: number[],
  windowSeconds = 120,
  maxLines = 150
): LogLine[] {
  const seeds = new Set(seedIds);
  const seedTimes = lines
    .filter((l) => seeds.has(l.id))
    .map((l) => parseTimestampMs(l.timestamp))
    .filter((t): t is number => t !== null);

  if (seedTimes.length === 0) return [];

  const windowMs = windowSeconds * 1000;
  const from = Math.min(...seedTimes) - windowMs;
  const to = Math.max(...seedTimes) + windowMs;

  return lines
    .filter((l) => !seeds.has(l.id))
    .map((l) => ({ line: l, t: parseTimestampMs(l.timestamp) }))
    .filter((e): e is { line: LogLine; t: number } => e.t !== null && e.t >= from && e.t <= to)
    .map((e) => ({
      line: e.line,
      distance: Math.min(...seedTimes.map((s) => Math.abs(s - e.t))),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxLines)
    .map((e) => e.line)
    .sort((a, b) => a.id - b.id);
}

export interface Context {
  target: string;
  before: string[];
  after: string[];
}

/** Returns a wider window of lines around a given line id (e.g. full stack trace). */
export function getContext(lines: LogLine[], lineId: number, contextSize = 5): Context | null {
  const target = lines.find((l) => l.id === lineId);
  if (!target) return null;
  return {
    target: target.raw,
    before: lines.slice(Math.max(0, lineId - contextSize), lineId).map((l) => l.raw),
    after: lines.slice(lineId + 1, lineId + 1 + contextSize).map((l) => l.raw),
  };
}
