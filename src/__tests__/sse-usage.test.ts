import { describe, expect, it } from 'vitest';
import { SseUsageReader } from '../proxy/usage.js';

describe('incremental usage observation', () => {
  it('retains Google model metadata when usage arrives in a later event', () => {
    const reader = new SseUsageReader('google');
    reader.push('data: {"modelVersion":"gemini-3.8-flash"}\r\n\r\n');
    reader.push('data:{"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":3}}\n\n');
    expect(reader.finish()).toMatchObject({
      model: 'gemini-3.8-flash',
      inputTokens: 8,
      outputTokens: 3,
    });
  });
  it('reads multiline data and an unterminated final event', () => {
    const reader = new SseUsageReader('deepseek');
    reader.push(
      'data: {"model":"deepseek-flash",\ndata: "usage":{"prompt_tokens":8,"completion_tokens":3}}',
    );
    expect(reader.finish()).toMatchObject({ inputTokens: 8, outputTokens: 3 });
  });
  it('bounds each event, rather than rejecting a large chunk of small events', () => {
    const reader = new SseUsageReader('google');
    reader.push(('data: {"text":"' + 'x'.repeat(300) + '"}\n\n').repeat(4000));
    reader.push('data: {"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":3}}\n\n');
    expect(reader.finish()?.inputTokens).toBe(8);
  });
  it('rejects an oversized unfinished event without retaining an entire response', () => {
    const reader = new SseUsageReader('google');
    expect(() => reader.push('data: ' + 'x'.repeat(1_048_576))).toThrow('observation limit');
  });
});
