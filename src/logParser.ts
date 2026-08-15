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
