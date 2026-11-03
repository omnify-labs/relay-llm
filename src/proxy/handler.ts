/** Native provider passthrough shared by the Node server and edge Worker. */
import type { Context, MiddlewareHandler } from 'hono';
import { PROVIDERS, type ProviderName } from './providers.js';
import { logUsage, type UsageRecord } from '../billing/usage.js';
import { parseUsageFromBody, SseUsageReader, type ParsedUsage } from './usage.js';
export { parseUsageFromBody, parseUsageFromSSE } from './usage.js';

export interface UsageObservation {
  requestId: string;
  userId: string;
  provider: ProviderName;
  statusCode: number;
  latencyMs: number;
  outcome: 'complete' | 'interrupted' | 'unavailable';
  usage: ParsedUsage | null;
}

export interface ProxyOptions {
  apiKey?: string;
  /** Native Gemini on Google Cloud; only the URL and authentication change. */
  googleCloud?: { project: string; accessToken: string };
  requestId?: string;
  observe?: (event: UsageObservation) => Promise<void>;
  waitUntil?: (promise: Promise<unknown>) => void;
}

function upstreamRequest(
  c: Context,
  provider: ProviderName,
  apiKey: string,
  googleCloud?: ProxyOptions['googleCloud'],
): [URL, Headers] {
  const config = PROVIDERS[provider];
  const incoming = new URL(c.req.url);
  const url = googleCloud
    ? new URL(
        `https://aiplatform.googleapis.com/v1/projects/${googleCloud.project}` +
          '/locations/global/publishers/google/models/' +
          incoming.pathname.split('/').at(-1),
      )
    : new URL(config.upstream + incoming.pathname.slice(config.routePrefix.length));
  url.search = incoming.search;
  for (const key of ['key', 'access_token', 'api_key']) url.searchParams.delete(key);
  const headers = new Headers();
  // Only provider protocol headers cross the boundary. Browser cookies, Dassi JWTs,
  // forwarding headers and run identifiers must not reach a model provider.
  for (const name of [
    'content-type',
    'accept',
    'anthropic-version',
    'anthropic-beta',
    'openai-beta',
  ]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  headers.set('Accept-Encoding', 'identity');
  if (googleCloud) headers.set('Authorization', `Bearer ${googleCloud.accessToken}`);
  else if (config.authMethod === 'bearer') headers.set('Authorization', `Bearer ${apiKey}`);
  if (config.authMethod === 'x-api-key') {
    headers.set('x-api-key', apiKey);
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
  }
  if (!googleCloud && config.authMethod === 'query-param') url.searchParams.set('key', apiKey);
  return [url, headers];
}

async function defaultObserver(event: UsageObservation): Promise<void> {
  if (event.outcome !== 'complete' || !event.usage) {
    console.error(`[Relay] Usage unresolved request=${event.requestId} outcome=${event.outcome}`);
    return;
  }
  const record: UsageRecord = {
    ...event,
    ...event.usage,
    model: event.usage.model || 'unknown',
  };
  await logUsage(record);
}

async function observeResponse(
  stream: ReadableStream<Uint8Array>,
  streaming: boolean,
  metadata: Omit<UsageObservation, 'outcome' | 'usage'>,
  observe: (event: UsageObservation) => Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const sse = new SseUsageReader(metadata.provider);
  let body = '';
  let usage: ParsedUsage | null = null;
  let outcome: UsageObservation['outcome'] = 'unavailable';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const text = decoder.decode(value, { stream: !done });
      if (streaming) sse.push(text);
      else {
        body += text;
        if (body.length > 4_194_304) throw new Error('Usage body exceeds observation limit');
      }
      if (done) break;
    }
    usage = streaming ? sse.finish() : parseUsageFromBody(body, metadata.provider);
    outcome = usage ? 'complete' : 'unavailable';
  } catch {
    outcome = 'interrupted';
    // Do not await tee cancellation: the independent client branch may still be live.
    void reader.cancel().catch(() => {});
  } finally {
    reader.releaseLock();
  }
  await observe({ ...metadata, outcome, usage });
}

function clientResponse(
  stream: ReadableStream<Uint8Array>,
  abort: AbortController,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          reader.releaseLock();
        } else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        reader.releaseLock();
      }
    },
    cancel() {
      abort.abort();
      void reader.cancel().catch(() => {});
    },
  });
}

/** Forward raw bytes once; observe usage separately and propagate client cancellation. */
export function proxyHandler(
  provider: ProviderName,
  options: ProxyOptions = {},
): MiddlewareHandler {
  return async (c) => {
    const requestId = options.requestId ?? crypto.randomUUID();
    const apiKey = options.apiKey ?? process.env[PROVIDERS[provider].apiKeyEnvVar];
    const googleCloud = options.googleCloud;
    if (googleCloud) {
      if (
        provider !== 'google' ||
        !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(googleCloud.project) ||
        !googleCloud.accessToken
      )
        return c.json({ error: 'Provider is not configured' }, 503);
      if (
        !/\/v1beta\/models\/[a-zA-Z0-9._-]+:(streamGenerateContent|generateContent)$/.test(
          c.req.path,
        )
      )
        return c.json({ error: 'Unsupported provider endpoint' }, 404);
    } else if (!apiKey) return c.json({ error: 'Provider is not configured' }, 503);
    const [url, headers] = upstreamRequest(c, provider, apiKey ?? '', googleCloud);
    const abort = new AbortController();
    const signal = AbortSignal.any([c.req.raw.signal, abort.signal]);
    const startTime = Date.now();
    try {
      const init: RequestInit & { duplex: 'half' } = {
        method: c.req.method,
        headers,
        body: c.req.raw.body,
        duplex: 'half',
        signal,
        redirect: 'manual',
      };
      const upstream = await fetch(url.toString(), init);
      if (upstream.status >= 300 && upstream.status < 400) {
        void upstream.body?.cancel();
        return c.json({ error: 'Unexpected upstream redirect' }, 502);
      }
      const responseHeaders = new Headers(upstream.headers);
      for (const name of [
        'transfer-encoding',
        'connection',
        'set-cookie',
        'authorization',
        'x-api-key',
        'x-goog-api-key',
      ]) {
        responseHeaders.delete(name);
      }
      responseHeaders.set('x-relay-request-id', requestId);
      responseHeaders.set('cache-control', 'no-store, no-transform');
      // Provider errors are delivered unchanged and never treated as billable output.
      if (!upstream.ok || !upstream.body) {
        return new Response(upstream.body, {
          status: upstream.status,
          headers: responseHeaders,
        });
      }
      const [clientStream, usageStream] = upstream.body.tee();
      const observation = observeResponse(
        usageStream,
        (upstream.headers.get('content-type') ?? '').includes('text/event-stream'),
        {
          requestId,
          userId: c.get('userId') as string,
          provider,
          statusCode: upstream.status,
          latencyMs: Date.now() - startTime,
        },
        options.observe ?? defaultObserver,
      ).catch(() => {
        console.error(`[Relay] Usage delivery failed request=${requestId}`);
      });
      options.waitUntil?.(observation);
      return new Response(clientResponse(clientStream, abort), {
        status: upstream.status,
        headers: responseHeaders,
      });
    } catch {
      // Fetch errors can contain the provider URL and its Google API key.
      return c.json(
        {
          error: signal.aborted ? 'Request canceled' : 'Upstream request failed',
        },
        502,
      );
    }
  };
}
