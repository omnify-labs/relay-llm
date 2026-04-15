# RelayLLM

LLM proxies like LiteLLM and Portkey translate your requests between provider formats. This works fine for simple chat completions. **It breaks tool calling.**

## The problem

When a proxy translates Anthropic's tool call format to OpenAI's (or vice versa), it parses, restructures, and re-serializes every tool call. This causes real corruption:

**Parallel tool calls get merged into invalid JSON** ([LiteLLM #10034](https://github.com/BerriAI/litellm/issues/10034), [Portkey #1275](https://github.com/Portkey-AI/gateway/issues/1275)):

```json
// What the LLM returned (3 separate tool calls):
[
  {"function": {"arguments": "{\"location\": \"San Francisco\"}", "name": "get_weather"}},
  {"function": {"arguments": "{\"location\": \"Tokyo\"}", "name": "get_weather"}},
  {"function": {"arguments": "{\"location\": \"Paris\"}", "name": "get_weather"}}
]

// What the proxy delivered (two objects smashed together, invalid JSON):
[
  {"function": {"arguments": "{\"location\": \"San Francisco\"}{\"location\": \"Tokyo\"}", "name": "get_weather"}},
  {"function": {"arguments": "{}", "name": "get_weather"}}
]
```

Your agent retries. And retries. And retries. 3-5x wasted LLM calls per corrupted response.

**`arguments` returned as object instead of string** ([Portkey #768](https://github.com/Portkey-AI/gateway/issues/768)). **Tool result messages reordered, breaking Anthropic's API** ([Portkey #980](https://github.com/Portkey-AI/gateway/issues/980)). **Role field concatenated 13 times during streaming** ([LiteLLM #12616](https://github.com/BerriAI/litellm/issues/12616)).

These aren't edge cases. They're the natural consequence of parsing and reconstructing structured data across incompatible schemas.

## How RelayLLM is different

RelayLLM never touches your payload. The entire proxy guarantee fits in 3 lines:

```typescript
// src/proxy/handler.ts — the request body is never parsed
const body = c.req.raw.body;
const response = await fetch(upstreamUrl, { method, headers, body });
return new Response(response.body, { status, headers });
```

No `JSON.parse`. No schema mapping. No reconstruction. Bytes in, bytes out.

```
LiteLLM / Portkey:
  App (OpenAI format) --> parse --> transform --> Provider --> transform back --> App
                           ^^ tool calls get JSON.parse'd, restructured, JSON.stringify'd

RelayLLM:
  App (native format) --> RelayLLM --> OpenAI / Anthropic / Google / DeepSeek / ...
                |
                +-- 1. Validates JWT (Supabase, Auth0, Firebase, any HS256)
                +-- 2. Checks per-user budget (fail-closed)
                +-- 3. Forwards request AS-IS (raw bytes, zero parsing)
                +-- 4. Streams response AS-IS (byte-for-byte)
                +-- 5. Extracts token usage (async, never blocks response)
                +-- 6. Logs usage to Postgres
```

The trade-off is explicit: you send requests in each provider's **native format**. You get back their **native response**. Nothing is translated, nothing is corrupted.

**What RelayLLM does:**
- Authenticates users (JWT -- works with Supabase, Auth0, Firebase, any HS256 issuer)
- Enforces per-user budgets (fail-closed -- DB error = reject request)
- Forwards requests byte-for-byte to the provider
- Streams responses byte-for-byte back to the client
- Extracts token counts asynchronously (never blocks the response)
- Logs usage to Postgres

**What RelayLLM does NOT do:**
- Parse, modify, or reconstruct request bodies
- Translate between API formats (OpenAI <-> Anthropic <-> Google)
- Touch tool calls, function parameters, or message content
- Buffer responses before sending

## How RelayLLM compares

|               | RelayLLM | Portkey | LiteLLM | OpenRouter |
|---------------|-------|---------|---------|------------|
| **Input format** | Native provider format | OpenAI format | OpenAI format | OpenAI format |
| **Request body** | Forwarded as raw bytes | Parsed + transformed | Parsed + transformed | Parsed + transformed |
| **Response body** | Streamed byte-for-byte | Reconstructed to OpenAI format | Reconstructed to OpenAI format | Reconstructed to OpenAI format |
| **Tool calls** | Untouched | JSON.parse/stringify both directions | JSON.parse/stringify both directions | JSON.parse/stringify both directions |
| **Architecture** | Reverse proxy (nginx-like) | Translation gateway | Translation gateway | Translation gateway |

## Who should use RelayLLM

**Use RelayLLM if:**
- You're building AI agents with tool use / function calling
- You talk to multiple providers in their native formats
- You need per-user billing without a translation layer in between
- You've been burned by proxy-induced tool call corruption

**Use LiteLLM or Portkey instead if:**
- You want one unified API format across all providers
- You don't use complex tool calling
- Format translation trade-offs are acceptable for your use case

## Supported Providers

| Provider | Route | Upstream |
|----------|-------|----------|
| OpenAI | `/v1/openai/**` | `api.openai.com` |
| Anthropic | `/v1/anthropic/**` | `api.anthropic.com` |
| Google | `/v1/google/**` | `generativelanguage.googleapis.com` |

Adding a provider is a single config entry in `src/proxy/providers.ts` — no translation logic needed since RelayLLM forwards everything as-is.

## Quick Start

```bash
git clone https://github.com/your-org/relay-llm.git
cd relay-llm
cp .env.example .env    # add your provider API keys + JWT secret
pnpm install && pnpm dev
```

Or with Docker:

```bash
docker compose up
```

Health check:

```bash
curl http://localhost:8080/health
# {"status": "ok"}
```

## Usage

Requests use the provider's native format. RelayLLM just forwards them.

```bash
# OpenAI
curl http://localhost:8080/v1/openai/v1/chat/completions \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'

# Anthropic
curl http://localhost:8080/v1/anthropic/v1/messages \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4-5", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'

# Google
curl http://localhost:8080/v1/google/v1beta/models/gemini-2.0-flash:generateContent \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"contents": [{"parts": [{"text": "Hello"}]}]}'
```

## Configuration

```bash
# Provider API keys (server-side only, never exposed to clients)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AIza...

# JWT validation (any HS256 secret — works with Supabase, Auth0, Firebase, etc.)
JWT_SECRET=your-jwt-secret

# Admin API secret (generate with: openssl rand -hex 32)
RELAY_ADMIN_SECRET=your-admin-secret

# Database
DATABASE_URL=postgresql://user:password@host:5432/dbname

# Server
PORT=8080
```

## Admin API

Manage user budgets via the Admin API, protected by `RELAY_ADMIN_SECRET`:

```bash
# Set a user's budget ($25.00)
curl -X PUT http://localhost:8080/admin/users/user-uuid/budget \
  -H "Authorization: Bearer $RELAY_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"budget": 25.00}'

# Reset spend (e.g., monthly renewal)
curl -X PUT http://localhost:8080/admin/users/user-uuid/budget \
  -H "Authorization: Bearer $RELAY_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"budget": 25.00, "reset_spend": true}'

# Remove a user
curl -X DELETE http://localhost:8080/admin/users/user-uuid \
  -H "Authorization: Bearer $RELAY_ADMIN_SECRET"
```

## Design Principles

1. **Never touch the payload** -- request and response bodies forwarded as raw bytes
2. **Never block the stream** -- usage extraction runs async on a tee'd copy
3. **Fail closed on budget** -- DB error on budget check = reject (prevent runaway spend)
4. **Fail open on logging** -- logging failure = request still succeeds
5. **One key per provider** -- RelayLLM holds API keys; clients authenticate with JWT

## Architecture

```
src/
  index.ts              # Server entry (Hono)
  proxy/
    handler.ts          # Byte-for-byte request forwarding + SSE streaming
    providers.ts        # Provider route config + upstream mapping
  auth/
    jwt.ts              # JWT validation middleware
  admin/
    handler.ts          # Budget management endpoints
    middleware.ts       # Admin secret auth
  billing/
    budget.ts           # Per-user budget enforcement
    usage.ts            # Async token usage logging
    pricing.ts          # Model pricing table
  db/
    client.ts           # Postgres connection
    queries.ts          # Usage + budget queries
  config/
    env.ts              # Environment variable validation
```

## Deploy

```bash
# Build and deploy to Cloud Run
docker build -t gcr.io/YOUR_PROJECT/relay-llm .
docker push gcr.io/YOUR_PROJECT/relay-llm

gcloud run deploy relay-llm \
  --image gcr.io/YOUR_PROJECT/relay-llm \
  --region us-central1 \
  --timeout 3600 \
  --memory 256Mi \
  --cpu 1
```

Set env vars via Cloud Run console or `--set-env-vars`. Never put API keys in CLI commands.

## License

AGPL-3.0 — see [LICENSE](LICENSE).

## Community

Join the [Discord](https://discord.gg/h82Y8rk4) for questions, discussion, and support.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
