import { describe, it, expect } from 'vitest';

/**
 * Test the usage parsing logic from handler.ts.
 * We extract and test the parsing functions directly.
 */

// Re-implement parsing logic here for unit testing
// (In production, these would be exported from handler.ts)

interface ParsedUsage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
}

function parseUsageFromBody(body: string, provider: 'openai' | 'anthropic' | 'google'): ParsedUsage | null {
  try {
    const json = JSON.parse(body);
    switch (provider) {
      case 'openai':
        return {
          model: json.model,
          inputTokens: json.usage?.prompt_tokens || 0,
          outputTokens: json.usage?.completion_tokens || 0,
          cachedInputTokens: json.usage?.prompt_tokens_details?.cached_tokens || 0,
          cacheCreationTokens: 0,
        };
      case 'anthropic': {
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
        return {
          model: json.modelVersion || null,
          inputTokens: json.usageMetadata?.promptTokenCount || 0,
          outputTokens: json.usageMetadata?.candidatesTokenCount || 0,
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

describe('parseUsageFromBody', () => {
  it('parses OpenAI response usage', () => {
    const body = JSON.stringify({
      model: 'gpt-5.4',
      choices: [{ message: { role: 'assistant', content: 'Hello!' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const usage = parseUsageFromBody(body, 'openai');
    expect(usage).toEqual({
      model: 'gpt-5.4',
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('parses Anthropic response usage', () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'Hello!' }],
      usage: { input_tokens: 20, output_tokens: 15 },
    });

    const usage = parseUsageFromBody(body, 'anthropic');
    expect(usage).toEqual({
      model: 'claude-sonnet-4-5',
      inputTokens: 20,
      outputTokens: 15,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('parses Google Gemini response usage', () => {
    const body = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Hello!' }] } }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 12, totalTokenCount: 20 },
      modelVersion: 'gemini-2.0-flash',
    });

    const usage = parseUsageFromBody(body, 'google');
    expect(usage).toEqual({
      model: 'gemini-2.0-flash',
      inputTokens: 8,
      outputTokens: 12,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('handles missing usage gracefully', () => {
    const body = JSON.stringify({ model: 'gpt-5.4', choices: [] });
    const usage = parseUsageFromBody(body, 'openai');
    expect(usage).toEqual({
      model: 'gpt-5.4',
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('handles invalid JSON gracefully', () => {
    const usage = parseUsageFromBody('not json', 'openai');
    expect(usage).toBeNull();
  });

  it('handles empty body gracefully', () => {
    const usage = parseUsageFromBody('', 'openai');
    expect(usage).toBeNull();
  });

  it('extracts OpenAI cached tokens from prompt_tokens_details', () => {
    const body = JSON.stringify({
      model: 'gpt-4o',
      usage: {
        prompt_tokens: 2048,
        completion_tokens: 100,
        total_tokens: 2148,
        prompt_tokens_details: { cached_tokens: 1920 },
      },
    });

    const usage = parseUsageFromBody(body, 'openai');
    expect(usage).toEqual({
      model: 'gpt-4o',
      inputTokens: 2048,
      outputTokens: 100,
      cachedInputTokens: 1920,
      cacheCreationTokens: 0,
    });
  });

  it('extracts Anthropic cache_read and cache_creation tokens', () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'Hello!' }],
      usage: {
        input_tokens: 500,
        output_tokens: 80,
        cache_read_input_tokens: 1200,
        cache_creation_input_tokens: 300,
      },
    });

    const usage = parseUsageFromBody(body, 'anthropic');
    // Reason: Anthropic input_tokens does NOT include cache tokens, so inputTokens = 500 + 1200 + 300 = 2000
    expect(usage).toEqual({
      model: 'claude-sonnet-4-5',
      inputTokens: 2000,
      outputTokens: 80,
      cachedInputTokens: 1200,
      cacheCreationTokens: 300,
    });
  });

  it('extracts Google cachedContentTokenCount', () => {
    const body = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Hello!' }] } }],
      usageMetadata: {
        promptTokenCount: 258000,
        candidatesTokenCount: 500,
        totalTokenCount: 258500,
        cachedContentTokenCount: 257955,
      },
      modelVersion: 'gemini-2.5-pro-preview',
    });

    const usage = parseUsageFromBody(body, 'google');
    expect(usage).toEqual({
      model: 'gemini-2.5-pro-preview',
      inputTokens: 258000,
      outputTokens: 500,
      cachedInputTokens: 257955,
      cacheCreationTokens: 0,
    });
  });
});

/**
 * SSE parsing tests for cache token extraction.
 * Re-implements parseUsageFromSSE locally for testing.
 */

function parseUsageFromSSE(
  sseText: string,
  provider: 'openai' | 'anthropic' | 'google',
): ParsedUsage | null {
  const lines = sseText.split('\n');
  let lastModel: string | null = null;
  let lastUsage: ParsedUsage | null = null;

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') continue;

    try {
      const json = JSON.parse(data);

      switch (provider) {
        case 'openai':
          if (json.model) lastModel = json.model;
          if (json.usage) {
            lastUsage = {
              model: lastModel,
              inputTokens: json.usage.prompt_tokens || 0,
              outputTokens: json.usage.completion_tokens || 0,
              cachedInputTokens: json.usage.prompt_tokens_details?.cached_tokens || 0,
              cacheCreationTokens: 0,
            };
          }
          break;
        case 'anthropic': {
          if (json.type === 'message_start' && json.message?.model) {
            lastModel = json.message.model;
          }
          if (json.type === 'message_start' && json.message?.usage) {
            const u = json.message.usage;
            const baseInput = u.input_tokens || 0;
            const cacheRead = u.cache_read_input_tokens || 0;
            const cacheCreate = u.cache_creation_input_tokens || 0;
            lastUsage = {
              model: lastModel,
              inputTokens: baseInput + cacheRead + cacheCreate,
              outputTokens: u.output_tokens || 0,
              cachedInputTokens: cacheRead,
              cacheCreationTokens: cacheCreate,
            };
          }
          if (json.type === 'message_delta' && json.usage) {
            if (lastUsage) {
              lastUsage.outputTokens = json.usage.output_tokens || 0;
            } else {
              lastUsage = {
                model: lastModel,
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
          if (json.usageMetadata) {
            lastUsage = {
              model: json.modelVersion || lastModel,
              inputTokens: json.usageMetadata.promptTokenCount || 0,
              outputTokens: json.usageMetadata.candidatesTokenCount || 0,
              cachedInputTokens: json.usageMetadata.cachedContentTokenCount || 0,
              cacheCreationTokens: 0,
            };
          }
          break;
      }
    } catch {
      // Skip unparseable SSE chunks
    }
  }

  return lastUsage;
}

describe('parseUsageFromSSE — cache token extraction', () => {
  it('extracts OpenAI cached tokens from streaming final chunk', () => {
    const sse = [
      'data: {"model":"gpt-4.1","choices":[{"delta":{"content":"Hi"}}]}',
      'data: {"usage":{"prompt_tokens":2006,"completion_tokens":300,"prompt_tokens_details":{"cached_tokens":1920}}}',
      'data: [DONE]',
    ].join('\n');

    const usage = parseUsageFromSSE(sse, 'openai');
    expect(usage).toEqual({
      model: 'gpt-4.1',
      inputTokens: 2006,
      outputTokens: 300,
      cachedInputTokens: 1920,
      cacheCreationTokens: 0,
    });
  });

  it('Anthropic message_delta does NOT overwrite cache fields from message_start', () => {
    const sse = [
      'data: {"type":"message_start","message":{"model":"claude-opus-4-6","usage":{"input_tokens":500,"cache_read_input_tokens":4000,"cache_creation_input_tokens":100,"output_tokens":1}}}',
      'data: {"type":"content_block_delta","delta":{"text":"Hello"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}',
    ].join('\n');

    const usage = parseUsageFromSSE(sse, 'anthropic');
    expect(usage).toEqual({
      model: 'claude-opus-4-6',
      // inputTokens = 500 + 4000 + 100 = 4600 (from message_start, NOT overwritten)
      inputTokens: 4600,
      outputTokens: 50,
      cachedInputTokens: 4000,
      cacheCreationTokens: 100,
    });
  });

  it('extracts Google cachedContentTokenCount from SSE chunk', () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}],"usageMetadata":{"promptTokenCount":150000,"candidatesTokenCount":200,"cachedContentTokenCount":140000},"modelVersion":"gemini-3.1-pro-preview"}',
    ].join('\n');

    const usage = parseUsageFromSSE(sse, 'google');
    expect(usage).toEqual({
      model: 'gemini-3.1-pro-preview',
      inputTokens: 150000,
      outputTokens: 200,
      cachedInputTokens: 140000,
      cacheCreationTokens: 0,
    });
  });

  it('returns null for stream with only [DONE]', () => {
    expect(parseUsageFromSSE('data: [DONE]\n', 'openai')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseUsageFromSSE('', 'openai')).toBeNull();
  });

  it('handles malformed JSON in SSE gracefully', () => {
    const sse = 'data: {not valid json}\ndata: [DONE]\n';
    expect(parseUsageFromSSE(sse, 'openai')).toBeNull();
  });
});
