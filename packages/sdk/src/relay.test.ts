import { describe, it, expect } from 'vitest';
import { relay, detectProvider, detectProviderFromApi } from './relay';
import { RELAY_PROVIDERS } from './constants';

describe('detectProvider', () => {
  it('detects anthropic from claude- prefix', () => {
    expect(detectProvider('claude-sonnet-4-5')).toBe('anthropic');
    expect(detectProvider('claude-opus-4-6')).toBe('anthropic');
    expect(detectProvider('claude-haiku-4-5')).toBe('anthropic');
  });

  it('detects google from gemini- prefix', () => {
    expect(detectProvider('gemini-3.1-pro-preview')).toBe('google');
    expect(detectProvider('gemini-2.0-flash')).toBe('google');
  });

  it('defaults to openai for gpt/o-series', () => {
    expect(detectProvider('gpt-5.4')).toBe('openai');
    expect(detectProvider('gpt-4o')).toBe('openai');
    expect(detectProvider('o4-mini')).toBe('openai');
    expect(detectProvider('o1-preview')).toBe('openai');
  });

  it('defaults to openai for unknown models', () => {
    expect(detectProvider('some-unknown-model')).toBe('openai');
  });

  it('strips provider/ prefix before detection', () => {
    expect(detectProvider('anthropic/claude-sonnet-4-5')).toBe('anthropic');
    expect(detectProvider('google/gemini-2.0-flash')).toBe('google');
    expect(detectProvider('openai/gpt-5.4')).toBe('openai');
  });
});

describe('detectProviderFromApi', () => {
  it('detects anthropic from anthropic-messages api', () => {
    expect(detectProviderFromApi('anthropic-messages')).toBe('anthropic');
  });

  it('detects google from google-generative-ai api', () => {
    expect(detectProviderFromApi('google-generative-ai')).toBe('google');
  });

  it('detects google from google-vertex api', () => {
    expect(detectProviderFromApi('google-vertex')).toBe('google');
  });

  it('detects openai from openai-responses api', () => {
    expect(detectProviderFromApi('openai-responses')).toBe('openai');
  });

  it('detects openai from openai-completions api', () => {
    expect(detectProviderFromApi('openai-completions')).toBe('openai');
  });

  it('defaults to openai for unknown api types', () => {
    expect(detectProviderFromApi('unknown-api')).toBe('openai');
  });
});

describe('relay(string)', () => {
  it('returns a Model with anthropic Relay baseUrl for claude models', () => {
    const model = relay('claude-sonnet-4-5');
    expect(model).toBeDefined();
    expect(model.baseUrl).toBe(RELAY_PROVIDERS.anthropic);
    expect(model.id).toBe('claude-sonnet-4-5');
  });

  it('returns a Model with google Relay baseUrl for gemini models', () => {
    const model = relay('gemini-2.0-flash');
    expect(model).toBeDefined();
    expect(model.baseUrl).toBe(RELAY_PROVIDERS.google);
  });

  it('returns a Model with openai Relay baseUrl for gpt models', () => {
    const model = relay('gpt-4o');
    expect(model).toBeDefined();
    expect(model.baseUrl).toBe(RELAY_PROVIDERS.openai);
  });

  it('strips provider/ prefix from model ID', () => {
    const model = relay('anthropic/claude-sonnet-4-5');
    expect(model).toBeDefined();
    expect(model.id).toBe('claude-sonnet-4-5');
    expect(model.baseUrl).toBe(RELAY_PROVIDERS.anthropic);
  });

  it('throws for unknown model not in pi-ai registry', () => {
    expect(() => relay('nonexistent-model-xyz')).toThrow();
  });
});

describe('relay(Model)', () => {
  it('overrides baseUrl without mutating the original', () => {
    const original = relay('claude-sonnet-4-5');
    // Reset baseUrl to simulate a "normal" model
    const normalModel = { ...original, baseUrl: 'https://api.anthropic.com' };

    const relayed = relay(normalModel);

    expect(relayed.baseUrl).toBe(RELAY_PROVIDERS.anthropic);
    expect(normalModel.baseUrl).toBe('https://api.anthropic.com'); // not mutated
  });

  it('detects provider from model.api field', () => {
    const original = relay('gemini-2.0-flash');
    const normalModel = { ...original, baseUrl: 'https://generativelanguage.googleapis.com' };

    const relayed = relay(normalModel);
    expect(relayed.baseUrl).toBe(RELAY_PROVIDERS.google);
  });
});

describe('relay() with custom relayUrl', () => {
  it('uses custom relayUrl for string input', () => {
    const model = relay('claude-sonnet-4-5', { relayUrl: 'https://custom.relay.com' });
    expect(model.baseUrl).toBe('https://custom.relay.com/v1/anthropic');
  });

  it('uses custom relayUrl for Model input', () => {
    const original = relay('gpt-4o');
    const normalModel = { ...original, baseUrl: 'https://api.openai.com/v1' };

    const relayed = relay(normalModel, { relayUrl: 'https://custom.relay.com' });
    expect(relayed.baseUrl).toBe('https://custom.relay.com/v1/openai/v1');
  });
});
