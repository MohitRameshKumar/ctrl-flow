import Anthropic from '@anthropic-ai/sdk';

/** Everything the LLM layer reads from the Worker environment. Model IDs live in wrangler.jsonc, not code. */
export interface LlmEnv {
  ANTHROPIC_API_KEY: string;
  /** Optional secret. Gemini is used only when this is set AND LLM_PROVIDER is "gemini". */
  GEMINI_API_KEY?: string;
  LLM_PROVIDER?: string;
  /** Cheap structured tasks (name_spaces, assign_tabs). */
  FAST_MODEL: string;
  /** Prose for people (standup, coverage_doc). */
  WRITING_MODEL: string;
  GEMINI_MODEL?: string;
}

export type ModelTier = 'fast' | 'writing';
export type LlmResult = { ok: true; text: string } | { ok: false; detail: string };

export interface LlmProvider {
  readonly name: string;
  complete(system: string, user: string, tier: ModelTier, maxTokens: number): Promise<LlmResult>;
}

class ClaudeProvider implements LlmProvider {
  readonly name = 'claude';
  constructor(private env: LlmEnv) {}

  async complete(system: string, user: string, tier: ModelTier, maxTokens: number): Promise<LlmResult> {
    try {
      const message = await new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY }).messages.create({
        model: tier === 'fast' ? this.env.FAST_MODEL : this.env.WRITING_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const block = message.content.find((b) => b.type === 'text');
      return block && block.type === 'text' ? { ok: true, text: block.text } : { ok: false, detail: 'no text block in response' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Gemini via the REST API (no SDK). Enabled only with a GEMINI_API_KEY secret + LLM_PROVIDER=gemini. UNTESTED against the live API. */
class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  constructor(private env: LlmEnv) {}

  async complete(system: string, user: string, _tier: ModelTier, maxTokens: number): Promise<LlmResult> {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.env.GEMINI_MODEL ?? 'gemini-2.5-flash'}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.env.GEMINI_API_KEY ?? '' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: { maxOutputTokens: maxTokens },
          }),
        },
      );
      if (!res.ok) return { ok: false, detail: `gemini HTTP ${res.status}` };
      const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
      return text ? { ok: true, text } : { ok: false, detail: 'no text in gemini response' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function selectProvider(env: LlmEnv): LlmProvider {
  return env.LLM_PROVIDER === 'gemini' && env.GEMINI_API_KEY ? new GeminiProvider(env) : new ClaudeProvider(env);
}

export type JsonResult<T> = { ok: true; value: T } | { ok: false; reason: 'api_error' | 'invalid_output'; detail?: string };

const JSON_ONLY = '\n\nRespond with ONLY a single JSON value. No prose, no markdown code fences.';

/** Strips a code fence that wraps the WHOLE output (models sometimes add one despite instructions). */
function unfence(text: string): string {
  const fenced = text.trim().match(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i);
  return fenced?.[1] !== undefined ? fenced[1].trim() : text.trim();
}

/**
 * Asks for JSON, validates the parsed shape with `validate`, and retries once on invalid output.
 * An API-level failure (auth, network, rate limit) is not retried — it is returned immediately so
 * callers can log it distinctly from a bad model response.
 */
export async function completeJson<T>(
  provider: LlmProvider,
  system: string,
  user: string,
  tier: ModelTier,
  validate: (value: unknown) => T | null,
  maxTokens = 4096,
): Promise<JsonResult<T>> {
  let detail: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await provider.complete(system + JSON_ONLY, user, tier, maxTokens);
    if (!res.ok) return { ok: false, reason: 'api_error', detail: res.detail };
    let parsed: unknown;
    try {
      parsed = JSON.parse(unfence(res.text));
    } catch (err) {
      detail = `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    const validated = validate(parsed);
    if (validated !== null) return { ok: true, value: validated };
    detail = 'parsed JSON did not match the expected shape';
  }
  return { ok: false, reason: 'invalid_output', detail };
}

/** Same retry-once contract for free-form text (Markdown), validated by `validate`. */
export async function completeText(
  provider: LlmProvider,
  system: string,
  user: string,
  tier: ModelTier,
  validate: (text: string) => string | null,
  maxTokens = 4096,
): Promise<JsonResult<string>> {
  let detail: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await provider.complete(system, user, tier, maxTokens);
    if (!res.ok) return { ok: false, reason: 'api_error', detail: res.detail };
    const validated = validate(unfence(res.text));
    if (validated !== null) return { ok: true, value: validated };
    detail = 'text did not match the expected format';
  }
  return { ok: false, reason: 'invalid_output', detail };
}
