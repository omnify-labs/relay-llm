import type { ProviderName } from './providers.js';

export interface ParsedUsage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
}

/**
 * Parse usage from a non-streaming response body.
 * Each provider reports usage differently.
 *
 * Semantic normalization:
 * - inputTokens always = total prompt tokens (including cached)
 * - Anthropic: input_tokens does NOT include cache tokens, so we add them back
 * - OpenAI/Google: prompt_tokens already includes cached, use as-is
 *
 * @param body - Raw (non-streaming) response body text.
 * @param provider - Upstream provider the request was proxied to (selects the usage schema).
 * @returns Parsed token usage, or null when the payload carries no usage block.
 */
export function parseUsageFromBody(body: string, provider: ProviderName): ParsedUsage | null {
  try {
    const json = JSON.parse(body);

    switch (provider) {
      case 'deepseek':
      case 'openai': {
        // Reason: Chat Completions reports prompt_tokens/completion_tokens; the
        // Responses API reports input_tokens/output_tokens (with
        // input_tokens_details.cached_tokens). Missing the second shape logged the
        // pro-tier Responses-only models at 0 tokens — billed $0.
        const u = json.usage;
        if (!u) return null;
        return {
          model: json.model,
          inputTokens: u?.prompt_tokens || u?.input_tokens || 0,
          outputTokens: u?.completion_tokens || u?.output_tokens || 0,
          cachedInputTokens:
            provider === 'deepseek'
              ? u?.prompt_cache_hit_tokens || 0
              : u?.prompt_tokens_details?.cached_tokens ||
                u?.input_tokens_details?.cached_tokens ||
                0,
          cacheCreationTokens: 0,
        };
      }
      case 'anthropic': {
        if (!json.usage) return null;
        const baseInput = json.usage?.input_tokens || 0;
        const cacheRead = json.usage?.cache_read_input_tokens || 0;
        const cacheCreate = json.usage?.cache_creation_input_tokens || 0;
        return {
          model: json.model,
          // Reason: Anthropic's input_tokens does NOT include cache tokens.
          // Normalize to total for consistent cost calculation.
          inputTokens: baseInput + cacheRead + cacheCreate,
          outputTokens: json.usage?.output_tokens || 0,
          cachedInputTokens: cacheRead,
          cacheCreationTokens: cacheCreate,
        };
      }
      case 'google':
        if (!json.usageMetadata) return null;
        return {
          model: json.modelVersion || null,
          inputTokens: json.usageMetadata?.promptTokenCount || 0,
          // Google bills thinking separately from visible candidate tokens.
          outputTokens:
            (json.usageMetadata.candidatesTokenCount || 0) +
            (json.usageMetadata.thoughtsTokenCount || 0),
          cachedInputTokens: json.usageMetadata?.cachedContentTokenCount || 0,
          cacheCreationTokens: 0,
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

interface UsageState {
  model: string | null;
  usage: ParsedUsage | null;
}

function applyEvent(data: string, provider: ProviderName, state: UsageState): void {
  if (data === '[DONE]') return;
  try {
    const json = JSON.parse(data);
    switch (provider) {
      case 'deepseek':
      case 'openai': {
        // Reason: Responses API streams carry model + usage under `response.*` on the
        // terminal `response.completed` event, not at the top level like Chat.
        if (json.model) state.model = json.model;
        if (json.response?.model) state.model = json.response.model;
        const u = json.usage ?? json.response?.usage;
        if (u) {
          state.usage = {
            model: state.model,
            inputTokens: u.prompt_tokens || u.input_tokens || 0,
            outputTokens: u.completion_tokens || u.output_tokens || 0,
            cachedInputTokens:
              provider === 'deepseek'
                ? u.prompt_cache_hit_tokens || 0
                : u.prompt_tokens_details?.cached_tokens ||
                  u.input_tokens_details?.cached_tokens ||
                  0,
            cacheCreationTokens: 0,
          };
        }
        break;
      }
      case 'anthropic': {
        if (json.type === 'message_start' && json.message?.model) {
          state.model = json.message.model;
        }
        // Reason: message_start.usage has input_tokens + cache fields.
        // message_delta.usage typically only has output_tokens.
        // We must NOT overwrite input/cache values from message_start with zeros from message_delta.
        if (json.type === 'message_start' && json.message?.usage) {
          const u = json.message.usage;
          const baseInput = u.input_tokens || 0;
          const cacheRead = u.cache_read_input_tokens || 0;
          const cacheCreate = u.cache_creation_input_tokens || 0;
          state.usage = {
            model: state.model,
            inputTokens: baseInput + cacheRead + cacheCreate,
            outputTokens: u.output_tokens || 0,
            cachedInputTokens: cacheRead,
            cacheCreationTokens: cacheCreate,
          };
        }
        if (json.type === 'message_delta' && json.usage) {
          if (state.usage) {
            state.usage.outputTokens = json.usage.output_tokens || 0;
          } else {
            state.usage = {
              model: state.model,
              inputTokens: 0,
              outputTokens: json.usage.output_tokens || 0,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
            };
          }
        }
        break;
      }
      case 'google':
        if (json.modelVersion) state.model = json.modelVersion;
        if (json.usageMetadata) {
          state.usage = {
            model: json.modelVersion || state.model,
            inputTokens: json.usageMetadata.promptTokenCount || 0,
            outputTokens:
              (json.usageMetadata.candidatesTokenCount || 0) +
              (json.usageMetadata.thoughtsTokenCount || 0),
            cachedInputTokens: json.usageMetadata.cachedContentTokenCount || 0,
            cacheCreationTokens: 0,
          };
        }
        break;
    }
  } catch {
    // Provider keepalives and non-JSON events carry no usage.
  }
}

/** Incremental SSE usage reader; retains at most one bounded event plus usage metadata. */
export class SseUsageReader {
  private pending = '';
  private data = '';
  private state: UsageState = { model: null, usage: null };
  constructor(private provider: ProviderName) {}

  /** Feed decoded text from the observation branch, never the client stream. */
  push(text: string): void {
    this.pending += text;
    let end: number;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end).replace(/\r$/, '');
      this.pending = this.pending.slice(end + 1);
      if (line === '') {
        if (this.data) applyEvent(this.data, this.provider, this.state);
        this.data = '';
      } else if (line.startsWith('data:')) {
        this.data += (this.data ? '\n' : '') + line.slice(5).replace(/^ /, '');
      }
      this.checkSize(this.data.length);
    }
    this.checkSize();
  }

  private checkSize(size = this.pending.length + this.data.length): void {
    if (size > 1_048_576) {
      throw new Error('Usage event exceeds observation limit');
    }
  }

  /** Finish a complete provider response, including its last unterminated event. */
  finish(): ParsedUsage | null {
    this.push('\n\n');
    return this.state.usage;
  }
}

/** Parse a complete SSE fixture using the same incremental reader as production. */
export function parseUsageFromSSE(text: string, provider: ProviderName): ParsedUsage | null {
  const reader = new SseUsageReader(provider);
  reader.push(text);
  return reader.finish();
}
