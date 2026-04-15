import { describe, it, expect } from 'vitest';
import { PROVIDERS } from '../proxy/providers.js';

describe('Provider configuration', () => {
  it('has all three providers configured', () => {
    expect(PROVIDERS.openai).toBeDefined();
    expect(PROVIDERS.anthropic).toBeDefined();
    expect(PROVIDERS.google).toBeDefined();
  });

  it('OpenAI uses bearer auth', () => {
    expect(PROVIDERS.openai.authMethod).toBe('bearer');
    expect(PROVIDERS.openai.upstream).toBe('https://api.openai.com');
    expect(PROVIDERS.openai.routePrefix).toBe('/v1/openai');
  });

  it('Anthropic uses x-api-key auth', () => {
    expect(PROVIDERS.anthropic.authMethod).toBe('x-api-key');
    expect(PROVIDERS.anthropic.upstream).toBe('https://api.anthropic.com');
    expect(PROVIDERS.anthropic.routePrefix).toBe('/v1/anthropic');
  });

  it('Google uses query-param auth', () => {
    expect(PROVIDERS.google.authMethod).toBe('query-param');
    expect(PROVIDERS.google.upstream).toBe('https://generativelanguage.googleapis.com');
    expect(PROVIDERS.google.routePrefix).toBe('/v1/google');
  });
});
