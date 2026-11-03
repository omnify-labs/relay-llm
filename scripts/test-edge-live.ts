/** Real-provider smoke tests against an explicitly configured staging Worker and database. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { checkServerIdentity } from 'node:tls';
import postgres from 'postgres';
import { parseUsageFromSSE } from '../src/proxy/usage.js';

// This ignored file holds a real Supabase session and the isolated staging DB credentials.
const env = JSON.parse(await readFile(process.env.EDGE_LIVE_ENV ?? '.cache/live-env.json', 'utf8'));
const base = process.env.EDGE_URL;
const local = process.env.EDGE_LOCAL_RUNTIME === '1';
if (!base || !(base.startsWith('https://') || (local && new URL(base).hostname === '127.0.0.1'))) {
  throw new Error('Set EDGE_URL to staging HTTPS, or explicitly select the local runtime');
}
const sql = postgres({
  host: env.dbHost,
  port: env.dbPort,
  database: 'relay_edge_staging',
  username: 'edge_staging',
  password: env.dbPassword,
  max: 1,
  ssl: {
    ca: await readFile('.cache/staging-ca.pem', 'utf8'),
    rejectUnauthorized: true,
    checkServerIdentity: (_hostname, cert) =>
      checkServerIdentity(env.dbTlsServerName ?? env.dbHost, cert),
  },
});
type Json = Record<string, any>; // Provider-native JSON is intentionally not translated by the relay.
type Model = { provider: 'google' | 'deepseek'; model: string };
const models: Model[] = [
  { provider: 'google', model: 'gemini-3.8-flash' },
  { provider: 'google', model: 'gemini-3.5-flash-lite' },
  { provider: 'deepseek', model: 'deepseek-flash' },
];
const results: {
  model: string;
  scenario: string;
  requestId: string;
  firstBytesMs: number;
  usage: unknown;
}[] = [];
const runId = `live-${crypto.randomUUID()}`;
const headers = {
  authorization: `Bearer ${env.token}`,
  'content-type': 'application/json',
  'x-dassi-run-id': runId,
};

function bodyFor(model: Model, prompt: string): Json {
  return model.provider === 'google'
    ? {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 4096 },
      }
    : {
        model: model.model,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 4096,
        thinking: { type: 'disabled' },
      };
}

async function request(
  model: Model,
  scenario: string,
  body: Json,
  cancel = false,
): Promise<Json[]> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 120_000);
  const started = Date.now();
  const path =
    model.provider === 'google'
      ? `/v1/google/v1beta/models/${model.model}:streamGenerateContent?alt=sse`
      : '/v1/deepseek/chat/completions';
  try {
    const response = await fetch(base + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    assert.equal(
      response.status,
      200,
      `${model.model}/${scenario}: HTTP ${response.status}: ${(response.ok ? '' : await response.text()).slice(0, 600)}`,
    );
    const requestId = response.headers.get('x-relay-request-id');
    assert.ok(requestId);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let firstBytesMs = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      if (!firstBytesMs) firstBytesMs = Date.now() - started;
      text += decoder.decode(value, { stream: true });
      if (cancel) {
        abort.abort();
        await reader.cancel().catch((error) => {
          if (error?.name !== 'AbortError') throw error;
        });
        break;
      }
    }
    const usage = cancel ? null : parseUsageFromSSE(text, model.provider);
    if (!cancel) assert.ok(usage && usage.inputTokens > 0, `${scenario}: provider usage missing`);
    results.push({ model: model.model, scenario, requestId, firstBytesMs, usage });
    console.log(`PASS ${model.model} ${scenario}: first bytes ${firstBytesMs} ms`);
    if (cancel) return [];
    return text.split(/\r?\n\r?\n/).flatMap((event) => {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      return !data || data === '[DONE]' ? [] : [JSON.parse(data)];
    });
  } finally {
    clearTimeout(timeout);
  }
}

function responseText(model: Model, events: Json[]): string {
  return events
    .map((event) =>
      model.provider === 'google'
        ? (event.candidates?.[0]?.content?.parts ?? [])
            .filter((part: Json) => !part.thought)
            .map((part: Json) => part.text ?? '')
            .join('')
        : (event.choices?.[0]?.delta?.content ?? ''),
    )
    .join('');
}

async function toolRoundTrip(model: Model): Promise<void> {
  const body = bodyFor(model, '请调用 lookup_weather 查询北京天气，然后用中文报告工具给你的温度。');
  const fn = {
    name: 'lookup_weather',
    description: 'Look up weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  };
  if (model.provider === 'google') {
    body.tools = [{ functionDeclarations: [fn] }];
    body.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [fn.name] } };
  } else {
    body.tools = [{ type: 'function', function: fn }];
    body.tool_choice = 'required';
  }
  const events = await request(model, 'tool-call', body);
  if (model.provider === 'google') {
    const parts = events.flatMap((event) => event.candidates?.[0]?.content?.parts ?? []);
    const call = parts.find((part) => part.functionCall)?.functionCall;
    assert.equal(call?.name, fn.name);
    assert.ok(call.args.city);
    // Preserve native thought signatures and function-call IDs exactly in the conversation.
    body.contents.push(
      { role: 'model', parts },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: fn.name,
              ...(call.id ? { id: call.id } : {}),
              response: { temperature_c: 23, city: '北京' },
            },
          },
        ],
      },
    );
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  } else {
    const calls: Json[] = [];
    let reasoning = '';
    for (const event of events) {
      const delta = event.choices?.[0]?.delta;
      reasoning += delta?.reasoning_content ?? '';
      for (const part of delta?.tool_calls ?? []) {
        const call = (calls[part.index] ??= {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        });
        if (part.id) call.id = part.id;
        call.function.name += part.function?.name ?? '';
        call.function.arguments += part.function?.arguments ?? '';
      }
    }
    assert.equal(calls[0]?.function.name, fn.name);
    assert.ok(JSON.parse(calls[0].function.arguments).city);
    body.messages.push(
      {
        role: 'assistant',
        content: null,
        tool_calls: calls,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      },
      {
        role: 'tool',
        tool_call_id: calls[0].id,
        content: JSON.stringify({ temperature_c: 23, city: '北京' }),
      },
    );
    body.tool_choice = 'auto';
  }
  assert.match(responseText(model, await request(model, 'tool-followup', body)), /23/);
}

async function imageRequest(model: Model): Promise<void> {
  const image = (await readFile(new URL('./fixtures/red-square.png', import.meta.url))).toString(
    'base64',
  );
  const body = bodyFor(model, '这张图片主要是什么颜色？只回答颜色。');
  if (model.provider === 'google')
    body.contents[0].parts.push({ inlineData: { mimeType: 'image/png', data: image } });
  else
    body.messages[0].content = [
      { type: 'text', text: body.messages[0].content },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
    ];
  assert.match(responseText(model, await request(model, 'image', body)), /红|red/i);
}

async function verifyLedger(): Promise<void> {
  const ids = results.map((row) => row.requestId);
  const deadline = Date.now() + 120_000;
  let rows: postgres.RowList<postgres.Row[]>;
  do {
    rows =
      await sql`SELECT request_id::text,outcome,settled_at FROM relay_internal.requests WHERE request_id::text IN ${sql(ids)}`;
    if (rows.length === ids.length && rows.every((row) => row.settled_at)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } while (Date.now() < deadline);
  assert.equal(rows.length, ids.length);
  assert.ok(
    rows.every((row) => row.settled_at),
    'Some usage observations did not reach the queue consumer',
  );
  const logs =
    await sql`SELECT request_id,input_tokens,output_tokens,cached_input_tokens,cost_usd FROM usage_logs WHERE request_id IN ${sql(ids)}`;
  for (const result of results) {
    const state = rows.find((row) => row.request_id === result.requestId)!;
    const charges = logs.filter((row) => row.request_id === result.requestId);
    if (result.scenario === 'cancel') {
      assert.ok(['complete', 'interrupted'].includes(state.outcome));
      assert.equal(charges.length, state.outcome === 'complete' ? 1 : 0);
    } else {
      assert.equal(state.outcome, 'complete');
      assert.equal(charges.length, 1);
      const usage = result.usage as {
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
      };
      assert.equal(charges[0].input_tokens, usage.inputTokens);
      assert.equal(charges[0].output_tokens, usage.outputTokens);
      assert.equal(charges[0].cached_input_tokens, usage.cachedInputTokens);
    }
  }
  const balance =
    await sql`SELECT spend, (SELECT coalesce(sum(cost_usd),0) FROM usage_logs WHERE billing_account_id=${env.userId}) AS logged FROM user_budgets WHERE user_id=${env.userId}`;
  assert.equal(Number(balance[0].spend), Number(balance[0].logged));
  console.log(
    `PASS ledger: ${rows.length} settled requests, ${logs.length} unique charges, account spend matches usage`,
  );
  await writeFile(
    '.cache/live-results.json',
    JSON.stringify(
      { runtime: local ? 'local-workerd' : 'cloudflare', results, ledger: rows, charges: logs },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

try {
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  const preflight = await fetch(base + '/v1/deepseek/chat/completions', {
    method: 'OPTIONS',
    headers: {
      origin: 'chrome-extension://test',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type,x-dassi-run-id',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  for (const model of models) {
    assert.match(
      responseText(
        model,
        await request(model, 'chinese', bodyFor(model, '请只用中文说一句你好。')),
      ),
      /[\u4e00-\u9fff]/,
    );
    await toolRoundTrip(model);
    await imageRequest(model);
    await request(
      model,
      'cancel',
      bodyFor(model, '请写一个很长的中文冒险故事。直接从第一句开始，不要列提纲，至少写两千字。'),
      true,
    );
    assert.ok(
      responseText(model, await request(model, 'after-cancel', bodyFor(model, '只回复：可以继续')))
        .length > 0,
    );
  }
  await verifyLedger();
} finally {
  await fetch(base + `/v1/runs/${runId}/end`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {});
  await sql.end();
}
