/** Paired regional latency probe. Logs timing/usage metadata, never tokens or content. */
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID, randomInt, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const endpoints = {
  current: "https://relay.dassi.ai",
  edge: "https://dassi-relay-edge-mvp.kklt92.workers.dev",
};
export const models = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "deepseek-flash"];

/** Parse native SSE incrementally and time answer text, excluding reasoning/metadata. */
export class AnswerTimer {
  pending = "";
  firstTextMs = null;
  lastTextMs = null;
  maxTextGapMs = 0;
  textChars = 0;
  answerEvents = 0;
  gapsOver2s = 0;
  gapsOver5s = 0;
  usage = null;
  modelVersion = null;
  finishReason = null;
  terminal = false;

  constructor(google) {
    this.google = google;
  }

  push(text, elapsed, done = false) {
    this.pending += text;
    if (this.pending.length > 4_194_304) throw new Error("sse_limit");
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.pending);
      if (!boundary) break;
      const frame = this.pending.slice(0, boundary.index);
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
      this.event(frame, elapsed);
    }
    if (done && this.pending.trim()) this.event(this.pending, elapsed);
    if (done) this.pending = "";
  }

  event(frame, elapsed) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      this.terminal = true;
      return;
    }
    const json = JSON.parse(data);
    if (json.error) throw new Error("provider_error");
    this.modelVersion = json.modelVersion ?? json.model ?? this.modelVersion;
    this.usage = json.usageMetadata ?? json.usage ?? this.usage;
    const choice = this.google ? json.candidates?.[0] : json.choices?.[0];
    this.finishReason =
      choice?.finishReason ?? choice?.finish_reason ?? this.finishReason;
    if (this.finishReason) this.terminal = true;
    const answer = this.google
      ? (choice?.content?.parts ?? [])
          .filter((part) => !part.thought)
          .map((part) => part.text ?? "")
          .join("")
      : (choice?.delta?.content ?? "");
    if (!answer.length) return;
    this.firstTextMs ??= elapsed;
    if (this.lastTextMs !== null) {
      const gap = elapsed - this.lastTextMs;
      if (gap >= 2000) this.gapsOver2s++;
      if (gap >= 5000) this.gapsOver5s++;
      this.maxTextGapMs = Math.max(
        this.maxTextGapMs,
        elapsed - this.lastTextMs,
      );
    }
    this.lastTextMs = elapsed;
    this.textChars += answer.length;
    this.answerEvents++;
  }
}

/** Build a native-provider request for the model, synthetic workload and unique pair label. */
export function payload(model, scenario, label) {
  const prompt =
    scenario === "short"
      ? `测试编号 ${label}。请只回复：你好，今天也要开心。`
      : `测试编号 ${label}。请阅读以下虚构记录，用约八十个汉字总结，不要列提纲。\n` +
        Array.from(
          { length: 50 },
          (_, i) =>
            `第${i + 1}天：团队上午整理资料，下午讨论产品并测试网页，发现等待回复的时间需要缩短。`,
        ).join("\n");
  return model.startsWith("gemini")
    ? {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 4096,
          temperature: 0,
          thinkingConfig: {
            thinkingLevel: model === "gemini-3.8-flash" ? "low" : "minimal",
          },
        },
      }
    : {
        model,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 1024,
        temperature: 0,
        thinking: { type: "disabled" },
      };
}

/** Send one request, consuming all output and preserving failure timings in the result. */
export async function measure(endpoint, model, body, token, runId, options = {}) {
  const google = model.startsWith("gemini");
  const path = google
    ? `/v1/google/v1beta/models/${model}:streamGenerateContent?alt=sse`
    : "/v1/deepseek/chat/completions";
  const parser = new AnswerTimer(google);
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const result = {
    endpoint,
    status: null,
    headersMs: null,
    firstBytesMs: null,
    requestId: null,
    colo: null,
    error: null,
    errorCode: null,
    maxByteGapMs: 0,
    wireChunks: 0,
  };
  let lastByteMs = null;
  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(endpoints[endpoint] + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-dassi-run-id": runId,
      },
      body,
      ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
      signal: AbortSignal.timeout(90_000),
      redirect: "error",
    });
    Object.assign(result, {
      status: response.status,
      headersMs: elapsed(),
      requestId: response.headers.get("x-relay-request-id"),
      colo: response.headers.get("cf-ray")?.split("-").at(-1) ?? null,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`http_${response.status}`);
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream"))
      throw new Error("not_sse");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        const ms = elapsed();
        if (value?.length) {
          result.firstBytesMs ??= ms;
          if (lastByteMs !== null) result.maxByteGapMs = Math.max(result.maxByteGapMs, ms - lastByteMs);
          lastByteMs = ms;
          result.wireChunks++;
        }
        parser.push(decoder.decode(value, { stream: !done }), ms, done);
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (parser.firstTextMs === null) throw new Error("no_answer");
    if (!parser.terminal || !parser.usage) throw new Error("incomplete");
    if (!["STOP", "stop"].includes(parser.finishReason))
      throw new Error("abnormal_finish");
  } catch (error) {
    const code = error.cause?.code ?? error.code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,50}$/.test(code)) result.errorCode = code;
    const known =
      /^(http_\d+|no_answer|incomplete|abnormal_finish|not_sse|provider_error|sse_limit)$/;
    result.error = known.test(error.message)
      ? error.message
      : error.name === "TimeoutError"
        ? "timeout"
        : "request_or_parse_error";
  }
  return {
    ...result,
    firstTextMs: parser.firstTextMs,
    lastTextMs: parser.lastTextMs,
    totalMs: elapsed(),
    maxTextGapMs: parser.maxTextGapMs,
    textChars: parser.textChars,
    answerEvents: parser.answerEvents,
    gapsOver2s: parser.gapsOver2s,
    gapsOver5s: parser.gapsOver5s,
    usage: parser.usage,
    modelVersion: parser.modelVersion,
    finishReason: parser.finishReason,
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return (sorted[mid] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2;
}

/** Summarize complete matched pairs; keep errors and unpaired successes visible. */
export function summarize(rows) {
  return models.flatMap((model) =>
    ["all", "short", "context"].map((scenario) => {
      const subset = rows.filter(
        (r) =>
          r.model === model && (scenario === "all" || r.scenario === scenario),
      );
      const pairs = [...new Set(subset.map((r) => r.pair))].map((pair) =>
        subset.filter((r) => r.pair === pair),
      );
      const matched = pairs.filter(
        (pair) => pair.length === 2 && pair.every((r) => !r.error),
      );
      const a = matched.map((pair) =>
        pair.find((r) => r.endpoint === "current"),
      );
      const b = matched.map((pair) => pair.find((r) => r.endpoint === "edge"));
      return {
        model,
        scenario,
        attemptedPairs: pairs.length,
        matchedPairs: matched.length,
        failures: Object.fromEntries(
          Object.keys(endpoints).map((endpoint) => [
            endpoint,
            subset.filter((r) => r.endpoint === endpoint && r.error).length,
          ]),
        ),
        currentFirstTextMedianMs: median(a.map((r) => r.firstTextMs)),
        edgeFirstTextMedianMs: median(b.map((r) => r.firstTextMs)),
        pairedFirstTextSavedMedianMs: median(
          a.map((r, i) => r.firstTextMs - b[i].firstTextMs),
        ),
        pairedFirstTextImprovementMedianPct: median(
          a.map(
            (r, i) =>
              (100 * (r.firstTextMs - b[i].firstTextMs)) / r.firstTextMs,
          ),
        ),
        edgeFirstTextWins: a.filter((r, i) => b[i].firstTextMs < r.firstTextMs)
          .length,
        currentTotalMedianMs: median(a.map((r) => r.totalMs)),
        edgeTotalMedianMs: median(b.map((r) => r.totalMs)),
      };
    }),
  );
}

async function main() {
  const config = JSON.parse(
    await readFile(
      process.env.BENCH_CONFIG ?? ".cache/latency-env.json",
      "utf8",
    ),
  );
  const output = process.env.BENCH_OUTPUT ?? ".cache/latency-results.json";
  const count = config.pairs ?? 20;
  if (!Number.isInteger(count) || count < 2 || count > 40 || count % 2)
    throw new Error("Use an even pair count between 2 and 40");
  const rows = [];
  const report = {
    startedAt: new Date().toISOString(),
    location: config.location,
    endpoints,
    node: process.version,
    warmup: [],
    rows,
  };
  const emit = (kind, value) =>
    console.log(`RELAY_BENCH ${JSON.stringify({ kind, ...value })}`);
  emit("start", {
    location: report.location,
    pairsPerModel: count,
    node: report.node,
  });
  const runId = `latency-${randomUUID()}`;
  try {
    for (const model of models) {
      // Warm each path with one request, retained separately from the measured sample.
      for (const endpoint of Object.keys(endpoints)) {
        const row = {
          model,
          ...(await measure(
            endpoint,
            model,
            JSON.stringify(payload(model, "short", "warmup")),
            config.token,
            runId,
          )),
        };
        report.warmup.push(row);
        emit("warmup", row);
        if (row.error)
          throw new Error(
            `Warmup failed for ${model}/${endpoint}: ${row.error}`,
          );
      }
      // Each scenario gets exactly half current-first and half edge-first when count=20.
      const schedules = {};
      for (const scenario of ["short", "context"]) {
        const order = Array.from({ length: count / 2 }, (_, i) => i % 2 === 0);
        for (let i = order.length - 1; i > 0; i--) {
          const j = randomInt(i + 1);
          [order[i], order[j]] = [order[j], order[i]];
        }
        schedules[scenario] = order;
      }
      for (let pair = 0; pair < count; pair++) {
        const scenario = pair % 2 ? "context" : "short";
        const body = JSON.stringify(payload(model, scenario, randomUUID()));
        const bodySha256 = createHash("sha256").update(body).digest("hex");
        const order = schedules[scenario].shift()
          ? ["current", "edge"]
          : ["edge", "current"];
        for (const [position, endpoint] of order.entries()) {
          const row = {
            model,
            pair,
            scenario,
            position,
            bodySha256,
            ...(await measure(endpoint, model, body, config.token, runId)),
          };
          rows.push(row);
          emit("sample", row);
          await writeFile(output, JSON.stringify(report, null, 2), {
            mode: 0o600,
          });
          if ([401, 402, 403].includes(row.status))
            throw new Error(`Access failed: ${row.status}`);
        }
      }
    }
    report.summary = summarize(rows);
    for (const summary of report.summary) emit("summary", summary);
    report.completedAt = new Date().toISOString();
  } finally {
    await Promise.allSettled(
      Object.values(endpoints).map((base) =>
        fetch(`${base}/v1/runs/${runId}/end`, {
          method: "POST",
          headers: { authorization: `Bearer ${config.token}` },
          signal: AbortSignal.timeout(15_000),
        }),
      ),
    );
    await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `RELAY_BENCH ${JSON.stringify({ kind: "fatal", name: error.name })}`,
    );
    process.exitCode = 1;
  });
}
