/**
 * Two ways to reach the model for the evaluator:
 *
 *   api          - @anthropic-ai/sdk with ANTHROPIC_API_KEY (and optionally
 *                  ANTHROPIC_BASE_URL, for a local gateway/proxy). Enforces the
 *                  output schema server-side (output_config.format).
 *   claude-code  - shells out to the `claude` CLI, using its logged-in Claude
 *                  subscription. No API key, no schema enforcement — the schema
 *                  goes into the prompt and the caller validates the result.
 *
 * Selection: LLM_PROVIDER env (`api` | `claude-code`), else auto — api when
 * ANTHROPIC_API_KEY is set, claude-code otherwise.
 */
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.LLM_MODEL ?? 'claude-opus-4-8';

export type Provider = 'api' | 'claude-code';

export function selectProvider(): Provider {
  const explicit = process.env.LLM_PROVIDER;
  if (explicit === 'api' || explicit === 'claude-code') return explicit;
  return process.env.ANTHROPIC_API_KEY ? 'api' : 'claude-code';
}

/** Returns the model's raw text response. Throws on refusal, truncation, or CLI failure. */
export async function complete(
  provider: Provider,
  system: string,
  user: string,
  schema: Record<string, unknown>,
): Promise<string> {
  const text =
    provider === 'api'
      ? await completeApi(system, user, schema)
      : await completeClaudeCode(system, user, schema);
  // output_config.format only guarantees clean JSON against the real Anthropic
  // API. A gateway/proxy in front of it (ANTHROPIC_BASE_URL) may not honour the
  // constraint and still wrap the reply in a markdown fence — strip unconditionally
  // rather than trusting the provider. A no-op against a real unfenced reply.
  return stripFences(text);
}

async function completeApi(
  system: string,
  user: string,
  schema: Record<string, unknown>,
): Promise<string> {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: user }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`Model refused: ${response.stop_details?.explanation ?? 'no explanation'}`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Model hit max_tokens — output truncated, refusing to write partial rules');
  }

  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Model returned no text block');
  return text;
}

async function completeClaudeCode(
  system: string,
  user: string,
  schema: Record<string, unknown>,
): Promise<string> {
  // No output_config over the CLI, so the schema is stated in the prompt and the
  // model is told to emit only JSON. The caller still validates — this is a
  // request, not a guarantee. Fence stripping happens once, in complete().
  const prompt = [
    system,
    '',
    'Respond with ONLY a JSON object matching this schema. No prose, no markdown fences:',
    JSON.stringify(schema),
    '',
    '--- TRADE REPORT ---',
    user,
  ].join('\n');

  const proc = Bun.spawn(['claude', '-p', '--output-format', 'json', '--model', 'opus'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(prompt);
  await proc.stdin.end();

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    if (/not found|ENOENT/i.test(stderr)) {
      throw new Error('`claude` CLI not found on PATH — install Claude Code or set LLM_PROVIDER=api');
    }
    throw new Error(`claude CLI exited ${code}: ${stderr.trim() || 'no stderr'}`);
  }

  // Envelope: { type: "result", subtype, is_error, result: "<text>", ... }
  let envelope: { is_error?: boolean; result?: string; subtype?: string };
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`claude CLI returned non-JSON envelope: ${stdout.slice(0, 200)}`);
  }
  if (envelope.is_error || !envelope.result) {
    throw new Error(`claude CLI reported an error (${envelope.subtype ?? 'unknown'})`);
  }

  return envelope.result;
}

/** The CLI often wraps JSON in a ```json fence despite instructions; peel it. */
export function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fence ? fence[1]!.trim() : trimmed;
}
