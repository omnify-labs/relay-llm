import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AnswerTimer, measure, summarize } from "./benchmark-relay.mjs";

test("malformed private configuration is not reproduced in error logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-benchmark-"));
  const config = join(directory, "config.json");
  try {
    await writeFile(config, '{"token":"private-credential",oops}');
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [new URL("./benchmark-relay.mjs", import.meta.url).pathname],
        {
          env: { ...process.env, BENCH_CONFIG: config },
        },
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.ok(!error.stderr.includes("private-credential"));
        assert.match(error.stderr, /SyntaxError/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("first answer excludes metadata and reasoning and tolerates split CRLF frames", () => {
  const timer = new AnswerTimer(true);
  timer.push('data: {"modelVersion":"gemini-test"}\r\n\r\n', 10);
  timer.push(
    'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"reasoning"}]}}]}\n\n',
    20,
  );
  timer.push('data: {"candidates":[{"content":{"parts":[{"text":"你', 25);
  assert.equal(timer.firstTextMs, null);
  timer.push('好"}]}}]}\r\n\r', 30);
  timer.push("\n", 35);
  assert.equal(timer.firstTextMs, 35);
  assert.equal(timer.textChars, 2);
  timer.push(
    'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":20}}\n\n',
    50,
  );
  assert.equal(timer.firstTextMs, 35);
  assert.equal(timer.terminal, true);
  assert.equal(timer.usage.promptTokenCount, 20);
});

test("DeepSeek role, reasoning and usage do not count as answer text", () => {
  const timer = new AnswerTimer(false);
  timer.push(
    'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"think"}}]}\n\n',
    10,
  );
  assert.equal(timer.firstTextMs, null);
  timer.push('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n', 30);
  timer.push(
    'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n',
    50,
  );
  timer.push(
    'data: {"usage":{"prompt_tokens":2,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
    60,
  );
  assert.equal(timer.firstTextMs, 30);
  assert.equal(timer.maxTextGapMs, 20);
  assert.equal(timer.textChars, 11);
  assert.equal(timer.terminal, true);
});

test('long answer pauses are counted independently of metadata events', () => {
  const timer = new AnswerTimer(false);
  timer.push('data: {"choices":[{"delta":{"content":"你"}}]}\n\n', 100);
  timer.push('data: {"choices":[{"delta":{"reasoning_content":"ignored"}}]}\n\n', 1000);
  timer.push('data: {"choices":[{"delta":{"content":"好"}}]}\n\n', 2200);
  timer.push('data: {"choices":[{"delta":{"content":"！"}}]}\n\n', 7300);
  assert.equal(timer.answerEvents, 3);
  assert.equal(timer.gapsOver2s, 2);
  assert.equal(timer.gapsOver5s, 1);
  assert.equal(timer.maxTextGapMs, 5100);
});

test("failed pairs remain in failure totals and are excluded from matched speed statistics", () => {
  const row = {
    model: "deepseek-flash",
    scenario: "short",
    totalMs: 100,
    error: null,
  };
  const result = summarize([
    { ...row, pair: 0, endpoint: "current", firstTextMs: 100 },
    { ...row, pair: 0, endpoint: "edge", firstTextMs: 60 },
    { ...row, pair: 1, endpoint: "current", firstTextMs: 80 },
    { ...row, pair: 1, endpoint: "edge", firstTextMs: null, error: "timeout" },
  ]).find((entry) => entry.model === row.model && entry.scenario === "all");
  assert.equal(result.matchedPairs, 1);
  assert.equal(result.failures.edge, 1);
  assert.equal(result.pairedFirstTextImprovementMedianPct, 40);
});

test("HTTP failure records metadata without copying provider error content or credentials", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("private-provider-error", { status: 429 });
  try {
    const row = await measure(
      "edge",
      "deepseek-flash",
      "{}",
      "private-token",
      "test",
    );
    assert.equal(row.error, "http_429");
    assert.equal(row.firstTextMs, null);
    assert.ok(!JSON.stringify(row).includes("private"));
  } finally {
    globalThis.fetch = original;
  }
});
