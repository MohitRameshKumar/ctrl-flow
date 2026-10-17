import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-5-5';
const MAX_TOKENS = 4096;

export type ClaudeJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'api_error' | 'invalid_json'; detail?: string };

/**
 * Calls Claude with a JSON-only instruction, validates the parsed shape with `validate`,
 * and retries once on invalid JSON or a failed shape check. An API-level failure (auth,
 * network, rate limit) is not retried — it's returned immediately so the caller can log it
 * distinctly from a bad model response.
 */
export async function callClaudeForJson<T>(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  validate: (value: unknown) => T | null,
): Promise<ClaudeJsonResult<T>> {
  const client = new Anthropic({ apiKey });
  let lastDetail: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    let message;
    try {
      message = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: `${systemPrompt}\n\nRespond with ONLY a single JSON value. No prose, no markdown code fences.`,
        messages: [{ role: 'user', content: userPrompt }],
      });
    } catch (err) {
      return { ok: false, reason: 'api_error', detail: err instanceof Error ? err.message : String(err) };
    }

    const textBlock = message.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      lastDetail = 'no text block in response';
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(textBlock.text));
    } catch (err) {
      lastDetail = `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }

    const validated = validate(parsed);
    if (validated !== null) return { ok: true, value: validated };
    lastDetail = 'parsed JSON did not match the expected shape';
  }

  return { ok: false, reason: 'invalid_json', detail: lastDetail };
}

/** Strips markdown code fences if the model wrapped the JSON despite instructions. */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenced?.[1] !== undefined ? fenced[1] : text.trim();
}
