/**
 * Proxy request handler.
 * Forwards requests byte-for-byte to the upstream provider.
 * Streams responses byte-for-byte back to the client.
 * Extracts token usage asynchronously without blocking the stream.
 *
 * Design principles:
 * 1. NEVER parse or modify the request body
 * 2. NEVER buffer the response — stream immediately
 * 3. Extract usage from response headers/final chunks asynchronously
 * 4. Log usage after the response completes (fire-and-forget)
 */

import type { Context, MiddlewareHandler } from 'hono';
import { PROVIDERS, type ProviderName } from './providers.js';
import { logUsage } from '../billing/usage.js';

/**
 * Build upstream URL by stripping the route prefix and appending to the provider's base URL.
 */
function buildUpstreamUrl(path: string, provider: ProviderName, query: string): string {
  const config = PROVIDERS[provider];
  const upstreamPath = path.replace(config.routePrefix, '');
  let url = `${config.upstream}${upstreamPath}`;

  // Forward any existing query params from the client
  if (query) {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}${query}`;
  }

  // Reason: Google uses API key as query parameter, appended after client params
  // so both ?alt=sse (from client) and ?key=xxx (server-side) are present.
  if (config.authMethod === 'query-param') {
    const apiKey = process.env[config.apiKeyEnvVar]!;
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}key=${apiKey}`;
  }

  return url;
}

/**
 * Build upstream headers.
 * Replaces the client's Authorization with the provider's API key.
 * Forwards all other headers unchanged.
 */
function buildUpstreamHeaders(
  originalHeaders: Headers,
  provider: ProviderName,
): Headers {
  const config = PROVIDERS[provider];
  const headers = new Headers();

  // Forward all headers except auth-related ones
  for (const [key, value] of originalHeaders.entries()) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'x-goog-api-key' || lower === 'host') {
      continue;
    }
    headers.set(key, value);
  }

  // Set the provider's API key
  const apiKey = process.env[config.apiKeyEnvVar]!;
  if (config.authMethod === 'bearer') {
    headers.set('Authorization', `Bearer ${apiKey}`);
  } else if (config.authMethod === 'x-api-key') {
    headers.set('x-api-key', apiKey);
    // Anthropic also requires anthropic-version header
    if (!headers.has('anthropic-version')) {
      headers.set('anthropic-version', '2023-06-01');
    }
  }
  // query-param auth is handled in buildUpstreamUrl

  return headers;
}

/**
 * Create a proxy handler for a specific provider.
 * Returns a Hono middleware that forwards requests as-is.
 */
export function proxyHandler(provider: ProviderName): MiddlewareHandler {
  return async (c: Context) => {
    const userId = c.get('userId') as string;
    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    // Build upstream URL
    // Reason: Hono's c.req.query() returns Record<string, string | string[]> but URLSearchParams
    // only accepts Record<string, string>. Single-value params are always strings in practice.
    const queryParams = c.req.query()
      ? new URLSearchParams(c.req.query() as unknown as Record<string, string>).toString()
      : '';
    const upstreamUrl = buildUpstreamUrl(c.req.path, provider, queryParams);

    // Build upstream headers (swap auth, forward everything else)
    const upstreamHeaders = buildUpstreamHeaders(c.req.raw.headers, provider);

    // Forward the raw request body without parsing
    const body = c.req.raw.body;

    try {
      // Forward request to upstream provider
      const upstreamResponse = await fetch(upstreamUrl, {
        method: c.req.method,
        headers: upstreamHeaders,
        body: body,
        // @ts-expect-error — Node.js fetch supports duplex for streaming request bodies
        duplex: 'half',
      });

      const latencyMs = Date.now() - startTime;
      const contentType = upstreamResponse.headers.get('content-type') || '';
      const isStreaming = contentType.includes('text/event-stream');

      // Build response headers (forward provider headers to client)
      const responseHeaders = new Headers();
      for (const [key, value] of upstreamResponse.headers.entries()) {
        // Skip hop-by-hop headers
        const lower = key.toLowerCase();
        if (lower === 'transfer-encoding' || lower === 'connection') continue;
        responseHeaders.set(key, value);
      }
      responseHeaders.set('x-relay-request-id', requestId);

      if (!upstreamResponse.body) {
        return new Response(null, {
          status: upstreamResponse.status,
          headers: responseHeaders,
        });
      }

      if (isStreaming) {
        // SSE streaming: pipe through unchanged, tee for usage extraction
        const [clientStream, usageStream] = upstreamResponse.body.tee();

        // Async usage extraction — does not block the client stream
        extractAndLogUsage(usageStream, provider, userId, requestId, latencyMs).catch(
          (err) => {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            console.error(`[Relay] Usage logging failed: ${msg}`);
          },
        );

        return new Response(clientStream, {
          status: upstreamResponse.status,
          headers: responseHeaders,
        });
      } else {
        // Non-streaming: read body, log usage, return
        const responseBody = await upstreamResponse.arrayBuffer();

        // Async usage extraction from the response body
        extractAndLogUsageFromBody(
          new Uint8Array(responseBody),
          provider,
          userId,
          requestId,
          latencyMs,
          upstreamResponse.status,
        ).catch((err) => {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          console.error(`[Relay] Usage logging failed: ${msg}`);
        });

        return new Response(responseBody, {
          status: upstreamResponse.status,
          headers: responseHeaders,
        });
      }
    } catch (error) {
      // Reason: Only log error.message — the full error object from fetch can contain
      // the upstream URL with embedded API keys (e.g. Google's ?key=... query param).
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Relay] Proxy error for ${provider}: ${msg}`);
      // Reason: Never forward raw error.message to client — it may contain the
      // upstream URL with embedded API keys (e.g. Google's ?key=... query param).
      return c.json({ error: 'Upstream request failed' }, 502);
    }
  };
}

/**
 * Extract token usage from a streaming response (SSE).
 * Reads the tee'd stream to find the final chunk with usage data.
 * This runs concurrently with the client receiving the response.
 */
async function extractAndLogUsage(
  stream: ReadableStream<Uint8Array>,
  provider: ProviderName,
  userId: string,
  requestId: string,
  latencyMs: number,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let fullText = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullText += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  // Parse usage from the accumulated SSE text
  const usage = parseUsageFromSSE(fullText, provider);
  if (usage) {
    await logUsage({
      userId,
      provider,
      model: usage.model || 'unknown',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      requestId,
      latencyMs,
      statusCode: 200,
    });
  }
}

/**
 * Extract token usage from a non-streaming response body.
 */
async function extractAndLogUsageFromBody(
  body: Uint8Array,
  provider: ProviderName,
  userId: string,
  requestId: string,
  latencyMs: number,
  statusCode: number,
): Promise<void> {
  const text = new TextDecoder().decode(body);
  const usage = parseUsageFromBody(text, provider);
  if (usage) {
    await logUsage({
      userId,
      provider,
      model: usage.model || 'unknown',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      requestId,
      latencyMs,
      statusCode,
    });
  }
}

interface ParsedUsage {
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
 */
function parseUsageFromBody(body: string, provider: ProviderName): ParsedUsage | null {
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

/**
 * Parse usage from SSE streaming text.
 * Looks for the final chunk containing usage information.
 *
 * Semantic normalization:
 * - inputTokens always = total prompt tokens (including cached)
 * - Anthropic: message_start sets input/cache fields; message_delta only updates outputTokens (cache fields preserved)
 */
function parseUsageFromSSE(sseText: string, provider: ProviderName): ParsedUsage | null {
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
          // Reason: message_start.usage has input_tokens + cache fields.
          // message_delta.usage typically only has output_tokens.
          // We must NOT overwrite input/cache values from message_start with zeros from message_delta.
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
      // Skip unparseable SSE chunks — normal for partial data
    }
  }

  return lastUsage;
}
