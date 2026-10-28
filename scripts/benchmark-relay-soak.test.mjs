import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Agent, fetch } from "undici";
import {
  ConnectionProbe,
  percentile,
  pairSpec,
  runLane,
  summarizeSoak,
} from "./benchmark-relay-soak.mjs";

test("each workload gets balanced endpoint order and its own payload", () => {
  const cases = Array.from({ length: 6 }, (_, i) =>
    pairSpec("deepseek-flash", i, {
      short: true,
      context: false,
      stream: true,
    }),
  );
  for (const scenario of ["short", "context", "stream"]) {
    const matching = cases.filter((row) => row.scenario === scenario);
    assert.equal(matching.length, 2);
    assert.notEqual(matching[0].order[0], matching[1].order[0]);
    assert.ok(matching.every((row) => row.bodySha256.length === 64));
  }
  assert.match(JSON.parse(cases[2].body).messages[0].content, /六百字/);
});

test("percentiles exclude absent values and expose tail observations", () => {
  assert.equal(percentile([null, undefined, NaN], 0.95), null);
  assert.equal(percentile([10, 20, 30, 400], 0.95), 400);
  assert.equal(percentile([10, null, 20], 0.5), 10);
});

test("summaries retain mid-stream errors and split the sustained window", () => {
  const base = {
    model: "deepseek-flash",
    scenario: "stream",
    pair: 0,
    pairStartedMs: 0,
    firstTextMs: 200,
    lastTextMs: 800,
    streamOutputMs: 600,
    totalMs: 900,
    maxTextGapMs: 100,
    maxByteGapMs: 100,
    gapsOver2s: 0,
    gapsOver5s: 0,
    error: null,
  };
  const rows = [
    { ...base, endpoint: "current" },
    { ...base, endpoint: "edge", firstTextMs: 100 },
    { ...base, pair: 1, pairStartedMs: 130_000, endpoint: "current" },
    {
      ...base,
      pair: 1,
      pairStartedMs: 130_000,
      endpoint: "edge",
      error: "timeout",
      gapsOver2s: 1,
    },
  ];
  const summary = summarizeSoak(rows).find((r) => r.model === base.model);
  assert.equal(summary.matchedPairs, 1);
  assert.equal(summary.pairedFirstTextSavedMedianMs, 100);
  assert.equal(summary.endpoints.edge.failures, 1);
  assert.equal(summary.endpoints.edge.errorsAfterFirstAnswer, 1);
  assert.deepEqual(
    summary.twoMinuteWindows.map((r) => r.startMinute),
    [0, 2],
  );
});

test("a sustained lane repeats on cadence rather than stopping after a fixed sample count", async () => {
  let now = 0;
  const rows = [];
  await runLane({
    model: "deepseek-flash",
    started: 0,
    deadline: 50_000,
    cadenceMs: 20_000,
    firstByScenario: { short: true, context: true, stream: true },
    token: "private-token",
    runId: "test",
    state: { stop: null },
    record: async (row) => {
      rows.push(row);
    },
    now: () => now,
    pause: async (ms) => {
      now += ms;
    },
    send: async (endpoint) => {
      now += 2000;
      return {
        endpoint,
        status: 200,
        firstTextMs: 100,
        lastTextMs: 1000,
        error: null,
      };
    },
  });
  assert.equal(rows.length, 6);
  assert.deepEqual(
    rows.filter((r) => r.position === 0).map((r) => r.pairStartedMs),
    [0, 20_000, 40_000],
  );
  assert.ok(!JSON.stringify(rows).includes("private-token"));
});

test("an authorization failure stops the session and remains visible as an incomplete pair", async () => {
  const state = { stop: null };
  const rows = [];
  await runLane({
    model: "deepseek-flash",
    started: 0,
    deadline: 50_000,
    cadenceMs: 20_000,
    firstByScenario: { short: true },
    token: "private-token",
    runId: "test",
    state,
    record: async (row) => {
      rows.push(row);
    },
    now: () => 0,
    send: async (endpoint) => ({
      endpoint,
      status: 402,
      firstTextMs: null,
      lastTextMs: null,
      error: "http_402",
    }),
  });
  assert.equal(state.stop, "access_http_402");
  assert.equal(rows.length, 1);
  const summary = summarizeSoak(rows).find((r) => r.model === "deepseek-flash");
  assert.equal(summary.matchedPairs, 0);
  assert.equal(summary.endpoints.current.failures, 1);
});

test("native diagnostics prove that consecutive requests reuse one TCP connection", async () => {
  const server = createServer((_request, response) => response.end("ok"));
  server.keepAliveTimeout = 65_000;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const probe = new ConnectionProbe({ local: origin });
  const dispatcher = new Agent({
    connections: 1,
    pipelining: 1,
    keepAliveTimeout: 60_000,
  });
  try {
    for (let i = 0; i < 2; i++)
      assert.equal(await (await fetch(origin, { dispatcher })).text(), "ok");
    assert.equal(probe.events.length, 2);
    assert.deepEqual(
      probe.events.map((r) => r.reused),
      [false, true],
    );
    assert.equal(probe.events[0].connectionId, probe.events[1].connectionId);
    assert.ok(probe.events.every((r) => !("headers" in r)));
  } finally {
    probe.close();
    await dispatcher.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
