/**
 * Rate limiting for a publicly-reachable, unauthenticated deployment.
 *
 * The resource actually at risk isn't abuse in the generic sense — it's the
 * shared daily LLM quota. Gemini's free tier caps at 20 requests/day total,
 * and Groq's is generous but still finite. That quota is shared across every
 * visitor, so a per-IP limit alone isn't enough: ten different people making
 * two requests each would still exhaust it. Two independent limits, checked
 * before the request is allowed to touch the LLM pipeline at all:
 *
 *   - per-IP: stops one source (or one runaway script) from hogging it
 *   - global daily: protects the shared quota regardless of how many
 *     distinct IPs show up
 *
 * In-memory, deliberately. This deployment runs at --max-replicas 1, and
 * scale-to-zero already resets any in-memory state on a cold start — a
 * persistent store would be false precision for a single-instance demo.
 */

interface Limits {
  perIpMax: number;
  perIpWindowMs: number;
  globalDailyMax: number;
}

const DEFAULT_LIMITS: Limits = {
  perIpMax: 3,
  perIpWindowMs: 60 * 60 * 1000, // 1 hour
  globalDailyMax: 15,
};

const perIpTimestamps = new Map<string, number[]>();
let globalDayKey = "";
let globalCountToday = 0;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // UTC date, e.g. "2026-08-25"
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

/** Extracts the real client IP from behind Azure Container Apps' proxy (X-Forwarded-For), falling back to the socket for local/direct connections. */
export function clientIp(req: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } }): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

export function checkRateLimit(ip: string, limits: Limits = DEFAULT_LIMITS): RateLimitResult {
  const today = todayKey();
  if (today !== globalDayKey) {
    globalDayKey = today;
    globalCountToday = 0;
  }
  if (globalCountToday >= limits.globalDailyMax) {
    return {
      allowed: false,
      reason: `Daily demo quota reached (${limits.globalDailyMax} summarize_incident calls/day, shared across all visitors, resets at UTC midnight). search_logs and get_error_context remain unlimited.`,
    };
  }

  const now = Date.now();
  const windowStart = now - limits.perIpWindowMs;
  const recent = (perIpTimestamps.get(ip) ?? []).filter((t) => t > windowStart);
  if (recent.length >= limits.perIpMax) {
    return {
      allowed: false,
      reason: `Rate limit: max ${limits.perIpMax} summarize_incident calls per hour per visitor. Try again later.`,
    };
  }

  recent.push(now);
  perIpTimestamps.set(ip, recent);
  globalCountToday += 1;
  return { allowed: true };
}
