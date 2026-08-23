import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";

/**
 * Two providers, deliberately.
 *
 * Groq carries the bulk of the pipeline: its free tier allows enough requests
 * per day to actually run an eval suite, where Gemini's free tier caps at 20
 * requests/day (~5 queries) — measured, not assumed.
 *
 * Gemini is reserved for the verification step, and that is an architectural
 * choice rather than a quota one: a verifier running on the same model that
 * produced the claim shares its blind spots. Checking the claim with a
 * different model family makes the hallucination check genuinely independent.
 */
export type Provider = "groq" | "gemini";

export interface ModelSpec {
  provider: Provider;
  model: string;
  /**
   * Output budget. Keep this tight: Groq's free tier counts `max_tokens` as
   * *reserved* capacity against a per-minute token budget (8000 TPM on the
   * smaller models), so an oversized value gets the request rejected outright
   * with a 413 — regardless of how small the prompt is, and regardless of how
   * few tokens the model actually goes on to emit.
   */
  maxTokens: number;
  /**
   * Groq/gpt-oss only. These models emit reasoning tokens before the answer,
   * and those count against `maxTokens` — at default effort they can exhaust
   * the budget mid-JSON and fail with "max completion tokens reached before
   * generating a valid document". Lowering effort leaves room for the answer.
   */
  reasoningEffort?: "low" | "medium" | "high";
}

export const MODELS = {
  /** Cheap, high-frequency: turning a question into search keywords. Output is a handful of strings. */
  extraction: { provider: "groq", model: "openai/gpt-oss-20b", maxTokens: 1024, reasoningEffort: "low" } as ModelSpec,
  /** Reasoning-heavy: proposing a root cause. Emits reasoning tokens before the JSON, so needs headroom. */
  hypothesis: { provider: "groq", model: "openai/gpt-oss-120b", maxTokens: 6000, reasoningEffort: "low" } as ModelSpec,
  /** Independent check — different provider family from `hypothesis` on purpose. */
  verification: { provider: "gemini", model: "gemini-3.6-flash", maxTokens: 4096 } as ModelSpec,
  /** Used only when the Gemini verifier is unavailable; same-provider, so no longer independent. */
  verificationFallback: { provider: "groq", model: "qwen/qwen3.6-27b", maxTokens: 3000 } as ModelSpec,
} as const;

let groqClient: Groq | null = null;
let geminiClient: GoogleGenAI | null = null;

function groq(): Groq {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys");
  groqClient ??= new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groqClient;
}

function gemini(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey");
  geminiClient ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return geminiClient;
}

export function isConfigured(provider: Provider): boolean {
  return provider === "groq" ? !!process.env.GROQ_API_KEY : !!process.env.GEMINI_API_KEY;
}

/**
 * Single JSON-producing call, dispatched by provider.
 *
 * Both backends are given the same JSON Schema. Schemas must stick to the
 * intersection both accept — object/array/string/integer, `enum`,
 * `description`, `required`, `additionalProperties: false` — since Groq's
 * strict mode and Gemini's `responseJsonSchema` each support only a subset
 * (e.g. `minItems` is not safe in Groq strict mode).
 */
export async function generateJson<T>(
  spec: ModelSpec,
  schemaName: string,
  systemInstruction: string,
  prompt: string,
  schema: Record<string, unknown>
): Promise<T | null> {
  const raw =
    spec.provider === "groq"
      ? await callGroq(spec, schemaName, systemInstruction, prompt, schema)
      : await callGemini(spec, systemInstruction, prompt, schema);

  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function callGroq(
  spec: ModelSpec,
  schemaName: string,
  systemInstruction: string,
  prompt: string,
  schema: Record<string, unknown>
): Promise<string | null> {
  const send = (strict: boolean) =>
    groq().chat.completions.create({
      model: spec.model,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, strict, schema },
      },
      max_tokens: spec.maxTokens,
      ...(spec.reasoningEffort ? { reasoning_effort: spec.reasoningEffort } : {}),
    });

  try {
    const response = await send(true);
    return response.choices[0]?.message?.content ?? null;
  } catch (err) {
    // `json_validate_failed` with an empty `failed_generation` means strict
    // decoding could not produce conforming JSON within the budget — observed
    // on gpt-oss-120b, which emits reasoning tokens before the answer. Retry
    // once with non-strict decoding at the SAME budget; raising the budget
    // instead trips the per-minute token reservation limit (see maxTokens).
    if (!/json_validate_failed/.test((err as Error).message)) throw err;
    const response = await send(false);
    return response.choices[0]?.message?.content ?? null;
  }
}

async function callGemini(
  spec: ModelSpec,
  systemInstruction: string,
  prompt: string,
  schema: Record<string, unknown>
): Promise<string | null> {
  const response = await gemini().models.generateContent({
    model: spec.model,
    contents: prompt,
    config: {
      systemInstruction,
      maxOutputTokens: spec.maxTokens,
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    },
  });
  return response.text ?? null;
}
