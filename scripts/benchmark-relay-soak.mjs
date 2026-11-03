/** Sustained regional comparison. Persist metadata only; never prompts, headers or credentials. */
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID, randomInt, createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Agent, fetch as pooledFetch } from "undici";
import { endpoints, models, payload, measure } from "./benchmark-relay.mjs";

const scenarios = ["short", "context", "stream"];
const accessErrors = new Set([401, 402, 403]);

/** Observe actual socket reuse through native diagnostics without reading request headers. */
export class ConnectionProbe {
  events = [];
  sockets = new WeakMap();
  nextId = 0;
  constructor(origins = endpoints, now = () => performance.now()) {
    const started = now();
    this.started = started;
    this.listener = ({ request, socket }) => {
      const endpoint = Object.keys(origins).find(
        (key) => origins[key] === String(request.origin),
      );
      if (!endpoint || !socket) return;
      const reused = this.sockets.has(socket);
      if (!reused) this.sockets.set(socket, ++this.nextId);
      this.events.push({
        endpoint,
        atMs: Math.round(now() - started),
        connectionId: this.sockets.get(socket),
        reused,
        kind: request.path.startsWith("/v1/runs/") ? "lifecycle" : "model",
        protocol: socket.alpnProtocol || "http/1.1",
      });
    };
    channel("undici:client:sendHeaders").subscribe(this.listener);
  }
  close() {
    channel("undici:client:sendHeaders").unsubscribe(this.listener);
  }
}

/** Nearest-rank percentile; missing observations never become zero latency. */
export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
    : null;
}

/** Pair identical payload bytes and alternate endpoint order within every scenario. */
export function pairSpec(model, index, firstByScenario) {
  const scenario = scenarios[index % scenarios.length];
  const body = payload(
    model,
    scenario === "stream" ? "short" : scenario,
    randomUUID(),
  );
  if (scenario === "stream") {
    const prompt =
      `测试编号 ${randomUUID()}。请写一篇约六百字的中文短篇故事，分成十二段。` +
      "故事讲述一个工程师在香港修复网络故障。直接开始正文，不要提纲，不要解释任务。";
    if (model.startsWith("gemini")) body.contents[0].parts[0].text = prompt;
    else {
      body.messages[0].content = prompt;
      body.max_tokens = 2048;
    }
  }
  const encoded = JSON.stringify(body);
  const first =
    firstByScenario[scenario] !==
    Boolean(Math.floor(index / scenarios.length) % 2);
  return {
    scenario,
    body: encoded,
    bodySha256: createHash("sha256").update(encoded).digest("hex"),
    order: first ? ["current", "edge"] : ["edge", "current"],
  };
}

function endpointStats(rows) {
  const good = rows.filter((row) => !row.error);
  const metric = (key) => ({
    p50: percentile(
      good.map((r) => r[key]),
      0.5,
    ),
    p95: percentile(
      good.map((r) => r[key]),
      0.95,
    ),
  });
  return {
    requests: rows.length,
    successes: good.length,
    failures: rows.filter((r) => r.error).length,
    firstTextMs: metric("firstTextMs"),
    totalMs: metric("totalMs"),
    maxTextGapMs: metric("maxTextGapMs"),
    maxByteGapMs: metric("maxByteGapMs"),
    streamOutputMs: metric("streamOutputMs"),
    requestsWithAnswerGapOver2s: rows.filter((r) => r.gapsOver2s > 0).length,
    requestsWithAnswerGapOver5s: rows.filter((r) => r.gapsOver5s > 0).length,
    errorsAfterFirstAnswer: rows.filter(
      (r) => r.error && r.firstTextMs !== null,
    ).length,
    errors: Object.fromEntries(
      [...new Set(rows.filter((r) => r.error).map((r) => r.error))].map(
        (error) => [error, rows.filter((r) => r.error === error).length],
      ),
    ),
  };
}

function comparison(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.model}/${row.pair}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const matched = [...groups.values()].filter(
    (pair) => pair.length === 2 && pair.every((r) => !r.error),
  );
  const savings = matched.map(
    (pair) =>
      pair.find((r) => r.endpoint === "current").firstTextMs -
      pair.find((r) => r.endpoint === "edge").firstTextMs,
  );
  return {
    attemptedPairs: groups.size,
    matchedPairs: matched.length,
    pairedFirstTextSavedMedianMs: percentile(savings, 0.5),
    edgeFirstTextWins: savings.filter((n) => n > 0).length,
    endpoints: Object.fromEntries(
      Object.keys(endpoints).map((key) => [
        key,
        endpointStats(rows.filter((r) => r.endpoint === key)),
      ]),
    ),
  };
}

/** Preserve failures and stratify model/workload and time; never pool unlike models into a speed claim. */
export function summarizeSoak(rows) {
  return models.map((model) => {
    const subset = rows.filter((r) => r.model === model);
    return {
      model,
      ...comparison(subset),
      scenarios: scenarios.map((scenario) => ({
        scenario,
        ...comparison(subset.filter((r) => r.scenario === scenario)),
      })),
      twoMinuteWindows: [
        ...new Set(subset.map((r) => Math.floor(r.pairStartedMs / 120_000))),
      ]
        .sort((a, b) => a - b)
        .map((window) => ({
          startMinute: window * 2,
          ...comparison(
            subset.filter(
              (r) => Math.floor(r.pairStartedMs / 120_000) === window,
            ),
          ),
        })),
    };
  });
}

/** Run one sequential model session; model sessions share the same measurement window. */
export async function runLane({
  model,
  started,
  deadline,
  cadenceMs,
  firstByScenario,
  token,
  runId,
  dispatcher,
  state,
  record,
  now = () => performance.now(),
  pause = sleep,
  send = measure,
}) {
  let pair = 0;
  let due = started;
  while (!state.stop && now() < deadline) {
    if (now() < due) await pause(Math.min(due, deadline) - now());
    if (state.stop || now() >= deadline) break;
    const pairStartedMs = Math.round(now() - started);
    const spec = pairSpec(model, pair, firstByScenario);
    // Finish an admitted pair even if its second request crosses the scheduling deadline.
    for (const [position, endpoint] of spec.order.entries()) {
      if (state.stop) break;
      const requestStartedMs = Math.round(now() - started);
      const row = {
        model,
        pair,
        pairStartedMs,
        requestStartedMs,
        scenario: spec.scenario,
        position,
        bodySha256: spec.bodySha256,
        ...(await send(endpoint, model, spec.body, token, runId, {
          dispatcher,
          fetchImpl: pooledFetch,
        })),
      };
      row.streamOutputMs =
        row.firstTextMs === null || row.lastTextMs === null
          ? null
          : row.lastTextMs - row.firstTextMs;
      await record(row);
      if (accessErrors.has(row.status))
        state.stop = `access_http_${row.status}`;
    }
    pair++;
    due = Math.max(due + cadenceMs, now());
  }
}

async function main() {
  const config = JSON.parse(
    await readFile(process.env.BENCH_CONFIG ?? ".cache/soak-env.json", "utf8"),
  );
  const minutes = config.minutes ?? 20;
  if (![10, 15, 20].includes(minutes))
    throw new Error("Use 10, 15 or 20 minutes");
  const claims = JSON.parse(
    Buffer.from(config.token.split(".")[1], "base64url"),
  );
  if (claims.exp * 1000 < Date.now() + (minutes * 60 + 300) * 1000)
    throw new Error("Session expires too soon");
  const output = process.env.BENCH_OUTPUT ?? ".cache/soak-results.json";
  const report = {
    location: config.location,
    plannedMinutes: minutes,
    cadenceSeconds: 20,
    node: process.version,
    edgeVersion: config.edgeVersion ?? null,
    endpoints,
    transport:
      "HTTP/1.1; one keep-alive pool per model and endpoint; 60-second idle allowance",
    warmup: [],
    rows: [],
    connections: [],
  };
  const agents = Object.fromEntries(
    models.map((model) => [
      model,
      new Agent({
        connections: 1,
        pipelining: 1,
        keepAliveTimeout: 60_000,
        keepAliveMaxTimeout: 60_000,
      }),
    ]),
  );
  const probe = new ConnectionProbe();
  const runId = `soak-${randomUUID()}`;
  const state = { stop: null };
  let writes = Promise.resolve();
  const persist = () => {
    report.connections = probe.events;
    const snapshot = JSON.stringify(report, null, 2);
    writes = writes.then(async () => {
      await writeFile(output + ".tmp", snapshot, { mode: 0o600 });
      await rename(output + ".tmp", output);
    });
    return writes;
  };
  const emit = (kind, data) =>
    console.log(`RELAY_SOAK ${JSON.stringify({ kind, ...data })}`);
  let heartbeat;
  try {
    for (const model of models)
      for (const endpoint of Object.keys(endpoints)) {
        const row = {
          model,
          ...(await measure(
            endpoint,
            model,
            JSON.stringify(payload(model, "short", "warmup")),
            config.token,
            runId,
            { dispatcher: agents[model], fetchImpl: pooledFetch },
          )),
        };
        report.warmup.push(row);
        await persist();
        emit("warmup", row);
        if (accessErrors.has(row.status))
          throw new Error("Warmup access denied");
      }
    const started = performance.now();
    report.connectionMeasurementOffsetMs = Math.round(started - probe.started);
    report.startedAt = new Date().toISOString();
    emit("start", {
      location: config.location,
      plannedMinutes: minutes,
      models,
    });
    heartbeat = setInterval(
      () =>
        emit("progress", {
          elapsedSeconds: Math.round((performance.now() - started) / 1000),
          requests: report.rows.length,
          failures: report.rows.filter((r) => r.error).length,
        }),
      30_000,
    );
    const record = async (row) => {
      report.rows.push(row);
      emit("sample", row);
      await persist();
    };
    await Promise.all(
      models.map((model) =>
        runLane({
          model,
          started,
          deadline: started + minutes * 60_000,
          cadenceMs: 20_000,
          firstByScenario: Object.fromEntries(
            scenarios.map((s) => [s, Boolean(randomInt(2))]),
          ),
          token: config.token,
          runId,
          dispatcher: agents[model],
          state,
          record,
        }),
      ),
    );
    report.completedAt = new Date().toISOString();
    report.actualSeconds = Math.round((performance.now() - started) / 1000);
    report.stopReason = state.stop;
    report.summary = summarizeSoak(report.rows);
    for (const summary of report.summary) emit("summary", summary);
  } finally {
    clearInterval(heartbeat);
    await Promise.allSettled(
      Object.values(endpoints).map((base) =>
        pooledFetch(`${base}/v1/runs/${runId}/end`, {
          method: "POST",
          headers: { authorization: `Bearer ${config.token}` },
          signal: AbortSignal.timeout(15_000),
          dispatcher: agents[models[0]],
        }).then((response) => response.body?.cancel()),
      ),
    );
    probe.close();
    await Promise.allSettled(
      Object.values(agents).map((agent) => agent.close()),
    );
    await persist();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `RELAY_SOAK ${JSON.stringify({ kind: "fatal", name: error.name })}`,
    );
    process.exitCode = 1;
  });
}
