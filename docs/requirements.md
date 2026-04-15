# Relay LLM — Requirements Document

> **Status:** Stable

---

## 1. Problem Statement

Existing LLM proxy solutions (LiteLLM, Portkey, One-API) translate requests between provider formats. This format translation layer causes real issues:

1. **Tool call corruption** — Parallel tool calls get merged into invalid JSON, `arguments` returned as objects instead of strings, role fields concatenated during streaming
2. **No true passthrough** — Every proxy parses, transforms, and re-serializes request/response bodies
3. **Limited per-user control** — Most proxies lack fine-grained per-user budget enforcement and usage tracking

## 2. Goal

Build a **self-hosted, thin proxy** that:
- Forwards requests **directly** to each provider's native API (Google, Anthropic, OpenAI) with **zero format translation**
- Authenticates users via JWT (compatible with Supabase, Auth0, Firebase, or any HS256 issuer)
- Tracks per-user token usage and spend
- Enforces per-user budgets
- Supports SSE streaming passthrough

## 3. Architecture Overview

```
┌─────────────────────┐
│  Your Application    │
│                      │
│  Sends requests in   │
│  provider-native     │
│  format per model    │
└──────────┬──────────┘
           │ HTTPS (provider-native format)
           ▼
┌─────────────────────────────────────────────┐
│  Relay LLM Proxy                            │
│  (Cloud Run — TypeScript/Hono)              │
│                                             │
│  1. Validate JWT                            │
│  2. Check user budget                       │
│  3. Forward request AS-IS to provider       │
│  4. Stream response back to client          │
│  5. Parse token counts from response        │
│  6. Log usage to Postgres                   │
└──────┬──────────┬──────────┬───────────────┘
       │          │          │
       ▼          ▼          ▼
   Google      Anthropic   OpenAI
   API         API         API
```

### Key Principle: NO Format Translation

The proxy does **NOT** convert between API formats. Your application produces the correct request format for each provider. The proxy is a **dumb pipe** that:
- Reads the target provider from the request path (e.g., `/v1/google/...`, `/v1/anthropic/...`, `/v1/openai/...`)
- Forwards the request body + headers **unchanged** to the provider
- Streams the response back **unchanged**
- Asynchronously logs token usage after the response completes

## 4. Functional Requirements

### 4.1 Provider Routing

| Route Pattern | Upstream Target | Auth Method |
|---|---|---|
| `POST /v1/google/*` | `https://generativelanguage.googleapis.com/*` | Server-side Google API key |
| `POST /v1/anthropic/*` | `https://api.anthropic.com/*` | Server-side Anthropic API key |
| `POST /v1/openai/*` | `https://api.openai.com/*` | Server-side OpenAI API key |

- The proxy replaces the client's `Authorization` header with the server-side provider API key
- All other headers and the request body are forwarded **as-is**
- Response is streamed back **as-is** (SSE passthrough for streaming requests)

### 4.2 Authentication

- Every request must include `Authorization: Bearer <jwt>`
- Proxy validates the JWT using an HS256 secret
- Extracts `user_id` from the JWT claims
- Rejects expired/invalid tokens with `401 Unauthorized`

### 4.3 Per-User Budget Enforcement

- **Before forwarding** each request, check the user's remaining budget:
  - Query `user_billing` table for `user_id`
  - If `spend >= max_budget`, reject with `402 Payment Required` and a JSON error body
  - If user has no billing record, reject with `403 Forbidden`
- Budget is denominated in **USD**

### 4.4 Usage Tracking & Token Logging

After each successful response (streaming or non-streaming), log:

```sql
INSERT INTO usage_logs (
  user_id,
  provider,        -- 'google' | 'anthropic' | 'openai'
  model,           -- extracted from request body
  input_tokens,    -- from provider response
  output_tokens,   -- from provider response
  total_tokens,
  cost_usd,        -- calculated from token counts × model pricing
  request_id,      -- unique ID for dedup
  created_at
)
```

**Token count extraction per provider:**

| Provider | Source |
|----------|--------|
| Google (Gemini) | Response body: `usageMetadata.promptTokenCount`, `usageMetadata.candidatesTokenCount` |
| Anthropic | Response body: `usage.input_tokens`, `usage.output_tokens` |
| OpenAI | Response body: `usage.prompt_tokens`, `usage.completion_tokens` |

For **streaming** responses:
- Google: `usageMetadata` appears in the final SSE chunk
- Anthropic: `message_delta` event contains `usage` in the final event
- OpenAI: `usage` field appears in the final `[DONE]`-preceding chunk (when `stream_options.include_usage: true`)

Token extraction must be done **asynchronously** — never block the response stream to the client.

### 4.5 Spend Aggregation

- Update `user_billing.spend` incrementally:
  ```sql
  UPDATE user_billing
  SET spend = spend + :cost_usd,
      updated_at = NOW()
  WHERE user_id = :user_id
  ```
- Cost calculation uses a **model pricing table** (stored in config):

| Model | Input ($/1M tokens) | Output ($/1M tokens) |
|-------|--------------------|--------------------|
| gemini-2.5-pro | $1.25 | $10.00 |
| gemini-2.0-flash | $0.15 | $0.60 |
| claude-sonnet-4-5 | $3.00 | $15.00 |
| claude-opus-4 | $15.00 | $75.00 |
| claude-haiku-3-5 | $0.80 | $4.00 |
| gpt-4o | $2.50 | $10.00 |

*Prices are approximate and should be configurable.*

## 5. Non-Functional Requirements

### 5.1 Performance

- **Latency overhead:** < 50ms added per request (auth + budget check + forward)
- **Streaming:** Response must begin streaming to the client as soon as the first chunk arrives from the provider — no buffering
- **Concurrency:** Support at least 100 concurrent streaming connections

### 5.2 Reliability

- If the usage logging fails, the request should still succeed (log async, don't block)
- If the budget check DB query fails, **fail closed** (reject the request) to prevent runaway spend
- Implement retry logic for usage log writes (3 retries with exponential backoff)

### 5.3 Security

- Provider API keys are stored as environment variables on the server — never exposed to the client
- Client only authenticates via JWT — never sees provider keys
- Request/response bodies are not logged (privacy) — only metadata (tokens, model, timestamp)

### 5.4 Observability

- Structured logging for every request: `user_id`, `provider`, `model`, `latency_ms`, `status`, `tokens`
- Error logging with request context for debugging
- Dashboard-ready data in the `usage_logs` table for analytics

## 6. Database Schema

```sql
-- Usage log table (append-only)
CREATE TABLE usage_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  provider TEXT NOT NULL,           -- 'google' | 'anthropic' | 'openai'
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  request_id TEXT,                  -- for dedup
  latency_ms INTEGER,
  status_code INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_usage_logs_user_id ON usage_logs(user_id, created_at DESC);
CREATE INDEX idx_usage_logs_created_at ON usage_logs(created_at);

-- User billing table
CREATE TABLE user_billing (
  user_id UUID PRIMARY KEY,
  spend NUMERIC(10, 4) DEFAULT 0,
  max_budget NUMERIC(10, 4) DEFAULT 5,
  budget_reset_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## 7. Deployment

**Target: Google Cloud Run** (or any container platform)

- Cloud Run supports up to 60-minute request timeouts with native SSE streaming
- Docker multi-stage build: `node:22-slim` for builder + runner
- Config: `--timeout 3600 --memory 256Mi --cpu 1`
- Scale to zero enabled (cost efficiency)

Also deployable on: DigitalOcean, Fly.io, Railway, any VPS with Docker + nginx.

## 8. Architectural Decisions

### 8.1 Deployment: Cloud Run

**Reason:** Many serverless/edge platforms have streaming timeouts (e.g., 150-200s) that are too short for long-running LLM conversations with tool use (2-5 minutes). Cloud Run supports up to 60-minute request timeouts.

### 8.2 Language: TypeScript

**Rationale:**
- This is a **99% I/O-bound** service. Total CPU work per request: ~0.15ms. The upstream provider takes 500ms-30s.
- At moderate scale (<10,000 DAU), a single Node.js process handles all traffic trivially.
- The architecture is language-agnostic — same routes, same logic, same DB schema. A rewrite to Go/Rust is straightforward when needed.

### 8.3 Why Not Use Existing Solutions?

| Project | Why it doesn't fit |
|---------|-------------|
| LiteLLM | Tool call corruption from format translation |
| One-API | Same format translation architecture |
| Portkey | Hosted SaaS — vendor dependency, same translation issues |
| openai-forward | True passthrough but no auth/billing/tracking |
| Instawork/llm-proxy | True passthrough but no JWT auth, in-memory only |

The closest was **openai-forward** (true byte passthrough), but it lacks auth, billing, and usage tracking — ~70% of the required functionality would need to be built from scratch.

## 9. References

### Related Open-Source Projects
- [Instawork/llm-proxy](https://github.com/Instawork/llm-proxy) — Go, true passthrough, per-user rate limiting
- [google-gemini/proxy-to-gemini](https://github.com/google-gemini/proxy-to-gemini) — Official Google proxy
