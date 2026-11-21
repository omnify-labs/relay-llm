import type { Context, MiddlewareHandler } from 'hono';

export const TIMING_EXPOSE_HEADERS = [
  'x-relay-request-id',
  'server-timing',
  'x-relay-runtime',
  'x-relay-country',
  'cf-ray',
];

type Timing = {
  started: number;
  upstreamStarted?: number;
  upstreamHeadersMs?: number;
};
const requests = new WeakMap<Context, Timing>();

/** Measure application ingress to response headers, including auth and admission. */
export function requestTiming(runtime: 'node' | 'cloudflare-worker'): MiddlewareHandler {
  return async (c, next) => {
    const timing: Timing = { started: performance.now() };
    requests.set(c, timing);
    await next();
    if (!c.res.headers.has('x-relay-request-id'))
      c.header('x-relay-request-id', crypto.randomUUID());
    const total = performance.now() - timing.started;
    const values = [`relay_headers;dur=${total.toFixed(2)}`];
    if (timing.upstreamStarted !== undefined)
      values.push(`relay_pre_upstream;dur=${(timing.upstreamStarted - timing.started).toFixed(2)}`);
    if (timing.upstreamHeadersMs !== undefined)
      values.push(`upstream_headers;dur=${timing.upstreamHeadersMs.toFixed(2)}`);
    const cf = (c.req.raw as Request & { cf?: { country?: string } }).cf;
    const country = cf?.country ?? c.req.header('cf-ipcountry');
    c.header('server-timing', values.join(', '));
    c.header('timing-allow-origin', '*');
    c.header('x-relay-runtime', runtime);
    c.header('x-relay-country', country && /^[A-Z]{2}$/.test(country) ? country : 'unknown');
    if (c.req.path === '/health') c.header('cache-control', 'no-store');
    const clientRequestId = c.req.header('x-request-id');
    try {
      console.log(
        JSON.stringify({
          event: 'relay_headers',
          requestId: c.res.headers.get('x-relay-request-id'),
          ...(clientRequestId && /^dassi-[a-z0-9-]{1,60}$/.test(clientRequestId)
            ? { clientRequestId }
            : {}),
          runtime,
          country: c.res.headers.get('x-relay-country'),
          status: c.res.status,
          serverHeadersMs: total,
          ...(timing.upstreamStarted !== undefined
            ? { preUpstreamMs: timing.upstreamStarted - timing.started }
            : {}),
          ...(timing.upstreamHeadersMs !== undefined
            ? { upstreamHeadersMs: timing.upstreamHeadersMs }
            : {}),
        }),
      );
    } catch {
      // Observability cannot interrupt forwarding or affect billing.
    }
  };
}

/** Mark provider dispatch without reading or buffering the request body. */
export function startUpstreamTiming(c: Context): void {
  const timing = requests.get(c);
  if (timing) timing.upstreamStarted = performance.now();
}

/** Mark receipt of provider headers; this is not the first generated token. */
export function endUpstreamTiming(c: Context): void {
  const timing = requests.get(c);
  if (timing?.upstreamStarted !== undefined)
    timing.upstreamHeadersMs = performance.now() - timing.upstreamStarted;
}
